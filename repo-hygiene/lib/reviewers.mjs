import { findCoveringLine, codeownersForFiles } from './codeowners.mjs'

const KNOWN_BOTS = new Set(['dependabot', 'github-actions', 'renovate'])

/** GitHub allows at most this many requested reviewers on a PR. */
const MAX_REVIEWERS = 15

/**
 * Split CODEOWNERS owner tokens into unique user logins and team
 * slugs, without the `@` and org prefixes.
 */
export function splitReviewers(ownerTokens) {
  const users = new Set()
  const teams = new Set()
  for (const tok of ownerTokens) {
    const login = String(tok).replace(/^@/, '')
    if (login) {
      if (login.includes('/')) {
        const [, team] = login.split('/')
        if (team) teams.add(team)
      } else {
        users.add(login)
      }
    }
  }
  return { users: [...users], teams: [...teams] }
}

async function listHumanContributors(octokit, { org, repo }) {
  let contribs = []
  try {
    const { data } = await octokit.rest.repos.listContributors({
      owner: org,
      repo,
      per_page: 100,
    })
    contribs = Array.isArray(data) ? data : []
  } catch (e) {
    if (e.status !== 404 && e.status !== 204) {
      throw e
    }
  }
  return contribs.filter(
    (c) =>
      c.type === 'User' && !/\[bot\]$/.test(c.login) && !KNOWN_BOTS.has(c.login)
  )
}

/**
 * Who should review the hygiene PR and own the CODEOWNERS lines it
 * adds. Tries, in order: owners of existing lines that already cover
 * a required pattern, any owner in CODEOWNERS, then human
 * contributors. Returns `{ reviewerTokens, reviewerSource,
 * ownerSubstitute }`; `ownerSubstitute` is only set in the first case,
 * as those owners are the right ones for the new lines too.
 */
export async function chooseReviewers(
  octokit,
  { org, repo, requiredCodeowners, parsedLines }
) {
  const matchedOwners = new Set()
  for (const req of requiredCodeowners) {
    const match = findCoveringLine(req, parsedLines)
    if (match) {
      match.owners.forEach((o) => matchedOwners.add(o))
    }
  }
  if (matchedOwners.size > 0) {
    return {
      reviewerTokens: [...matchedOwners],
      reviewerSource: 'codeowners-match',
      // Space-join when there are several, matching CODEOWNERS
      // multi-owner syntax.
      ownerSubstitute: [...matchedOwners].join(' '),
    }
  }

  const allOwners = new Set()
  for (const line of parsedLines) {
    line.owners.forEach((o) => allOwners.add(o))
  }
  if (allOwners.size > 0) {
    return {
      reviewerTokens: [...allOwners],
      reviewerSource: 'codeowners-fallback',
      ownerSubstitute: null,
    }
  }

  const humans = await listHumanContributors(octokit, { org, repo })
  if (humans.length > 0) {
    return {
      reviewerTokens: humans.map((h) => `@${h.login}`),
      reviewerSource: 'contributors',
      ownerSubstitute: null,
    }
  }

  return { reviewerTokens: [], reviewerSource: 'none', ownerSubstitute: null }
}

/**
 * Request reviewers one at a time. requestReviewers is all-or-nothing:
 * a single invalid entry (e.g. a past contributor who is no longer
 * a collaborator, or a team without repo access) 422s the whole call.
 * Requesting each reviewer separately — calls are additive — means
 * a bad entry only drops itself while the valid reviewers still get
 * assigned. Any other failure (auth, rate limit, server error) is
 * rethrown so the audit reports it instead of a partial success.
 * Stops once MAX_REVIEWERS have been accepted, so an invalid candidate
 * does not use up a slot. Returns the reviewers that were requested,
 * as `@` handles.
 */
export async function requestReviewersOneByOne(
  octokit,
  { org, repo, pullNumber, users, teams, log }
) {
  const requested = []
  for (const user of users) {
    if (requested.length >= MAX_REVIEWERS) break
    try {
      await octokit.rest.pulls.requestReviewers({
        owner: org,
        repo,
        pull_number: pullNumber,
        reviewers: [user],
      })
      requested.push(`@${user}`)
    } catch (e) {
      if (e.status !== 422) throw e
      log.warning(`could not request reviewer @${user}: ${e.message}`)
    }
  }
  for (const team of teams) {
    if (requested.length >= MAX_REVIEWERS) break
    try {
      await octokit.rest.pulls.requestReviewers({
        owner: org,
        repo,
        pull_number: pullNumber,
        team_reviewers: [team],
      })
      requested.push(`@${org}/${team}`)
    } catch (e) {
      if (e.status !== 422) throw e
      log.warning(
        `could not request team reviewer @${org}/${team}: ${e.message}`
      )
    }
  }
  return requested
}

// Open Dependabot PRs nobody has been asked to review. Reviewers drop
// off `requested_reviewers` once they review, so an empty list alone
// does not mean nobody was ever asked; check for reviews too.
async function findUnreviewedDependabotPrs(octokit, { org, repo, openPrs }) {
  const candidates = openPrs.filter(
    (pr) =>
      pr.user?.login === 'dependabot[bot]' &&
      (pr.requested_reviewers || []).length === 0 &&
      (pr.requested_teams || []).length === 0
  )
  const unreviewed = []
  for (const pr of candidates) {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner: org,
      repo,
      pull_number: pr.number,
      per_page: 100,
    })
    if (reviews.length === 0) unreviewed.push(pr)
  }
  return unreviewed
}

// Files a PR touches, including the old names of renamed files.
async function listPrFiles(octokit, { org, repo, pr }) {
  const changedFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: org,
    repo,
    pull_number: pr.number,
    per_page: 100,
  })
  return changedFiles.flatMap((f) =>
    [f.filename, f.previous_filename].filter(Boolean)
  )
}

/**
 * Dependabot PRs opened before CODEOWNERS covered their files never
 * get reviewers: GitHub only applies CODEOWNERS when a PR is opened or
 * pushed to. Find such PRs, work out who the current CODEOWNERS would
 * name for the files they touch and request those reviewers. Returns
 * one result per affected PR. `ctx` is the per-repo audit context.
 */
export async function checkDependabotReviewers(
  ctx,
  { openPrs, parsedCodeowners }
) {
  const { octokit, org, repo, repoSlug, dryRun, log } = ctx
  const results = []
  const prs = await findUnreviewedDependabotPrs(octokit, {
    org,
    repo,
    openPrs,
  })

  for (const pr of prs) {
    const files = await listPrFiles(octokit, { org, repo, pr })
    const ownerTokens = codeownersForFiles(files, parsedCodeowners).filter(
      // Emails are valid owners but cannot be requested as reviewers.
      (tok) => tok.startsWith('@')
    )
    const { users, teams } = splitReviewers(ownerTokens)
    const wanted = [
      ...users.map((u) => `@${u}`),
      ...teams.map((t) => `@${org}/${t}`),
    ]

    if (wanted.length === 0) {
      log.warning(
        `Dependabot PR ${pr.html_url} has no reviewers and CODEOWNERS names nobody for: ${files.join(', ')}`
      )
      results.push({
        repo: repoSlug,
        action: 'dependabot-no-reviewers',
        prUrl: pr.html_url,
        files,
      })
    } else if (dryRun) {
      log.info(
        `Dry run, would request ${wanted.join(', ')} on Dependabot PR ${pr.html_url}`
      )
      results.push({
        repo: repoSlug,
        action: 'dependabot-dry-run',
        prUrl: pr.html_url,
        reviewers: wanted,
      })
    } else {
      const reviewers = await requestReviewersOneByOne(octokit, {
        org,
        repo,
        pullNumber: pr.number,
        users,
        teams,
        log,
      })
      log.info(
        `requested ${reviewers.join(', ') || 'nobody'} on Dependabot PR ${pr.html_url}`
      )
      results.push({
        repo: repoSlug,
        action: 'dependabot-requested-reviewers',
        prUrl: pr.html_url,
        reviewers,
      })
    }
  }
  return results
}
