import { findCoveringLine } from './codeowners.ts'
import { errorMessage, httpStatus } from './github.ts'
import type {
  CodeownersLine,
  Logger,
  Octokit,
  ReviewerSource,
} from './types.ts'

const KNOWN_BOTS = new Set(['dependabot', 'github-actions', 'renovate'])

/** GitHub allows at most this many requested reviewers on a PR. */
const MAX_REVIEWERS = 15

/**
 * Split CODEOWNERS owner tokens into unique user logins and team
 * slugs, without the `@` and org prefixes.
 */
export function splitReviewers(ownerTokens: Array<string>): {
  users: Array<string>
  teams: Array<string>
} {
  const users = new Set<string>()
  const teams = new Set<string>()
  for (const tok of ownerTokens) {
    const login = tok.replace(/^@/, '')
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

interface Contributor {
  login?: string
  type?: string
}

async function listHumanContributors(
  octokit: Octokit,
  { org, repo }: { org: string; repo: string }
): Promise<Array<Contributor & { login: string }>> {
  let contribs: Array<Contributor> = []
  try {
    const { data } = await octokit.rest.repos.listContributors({
      owner: org,
      repo,
      per_page: 100,
    })
    contribs = Array.isArray(data) ? data : []
  } catch (e) {
    const status = httpStatus(e)
    if (status !== 404 && status !== 204) {
      throw e
    }
  }
  return contribs.filter(
    (c): c is Contributor & { login: string } =>
      c.type === 'User' &&
      typeof c.login === 'string' &&
      !/\[bot\]$/.test(c.login) &&
      !KNOWN_BOTS.has(c.login)
  )
}

interface ChooseReviewersParams {
  org: string
  repo: string
  requiredCodeowners: Array<string>
  parsedLines: Array<CodeownersLine>
}

interface ChosenReviewers {
  reviewerTokens: Array<string>
  reviewerSource: ReviewerSource
  ownerSubstitute: string | null
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
  octokit: Octokit,
  { org, repo, requiredCodeowners, parsedLines }: ChooseReviewersParams
): Promise<ChosenReviewers> {
  const matchedOwners = new Set<string>()
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

  const allOwners = new Set<string>()
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

interface RequestReviewersParams {
  org: string
  repo: string
  pullNumber: number
  users: Array<string>
  teams: Array<string>
  log: Logger
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
  octokit: Octokit,
  { org, repo, pullNumber, users, teams, log }: RequestReviewersParams
): Promise<Array<string>> {
  const requested: Array<string> = []
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
      if (httpStatus(e) !== 422) throw e
      log.warning(`could not request reviewer @${user}: ${errorMessage(e)}`)
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
      if (httpStatus(e) !== 422) throw e
      log.warning(
        `could not request team reviewer @${org}/${team}: ${errorMessage(e)}`
      )
    }
  }
  return requested
}
