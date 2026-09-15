import {
  parseCodeowners,
  findOwningLine,
  buildCodeownersAddition,
} from './codeowners.mjs'
import { detectEcosystems, planDependabotChange } from './dependabot-config.mjs'
import {
  tryGetContent,
  fetchBranchTree,
  commitChange,
  createLineComment,
} from './github.mjs'
import {
  chooseReviewers,
  splitReviewers,
  requestReviewersOneByOne,
} from './reviewers.mjs'

const WORKFLOW_LINK =
  'https://github.com/verkstedt/actions/blob/HEAD/repo-hygiene/'
// Also how PRs from earlier runs are recognised, so renaming it makes
// the action reopen PRs on every repo that already has one.
const BRANCH_PREFIX = 'chore/repo-hygiene/'
const OWNER_PLACEHOLDER = '@OWNER'
const PR_TITLE = 'chore: Repo hygiene'

// `[change, existingFile, codeFenceLang]` triples → the files the PR
// commits, skipping changes that are null.
function planFiles(candidates) {
  return candidates
    .filter(([change]) => change)
    .map(([change, existing, lang]) => ({
      change,
      exists: Boolean(existing),
      lang,
    }))
}

function composePrBody({ reviewerSource, files }) {
  const changes = files.map((f) => f.change)
  const bodyParts = [
    `🤖 Opened automatically by [repo-hygiene action from verkstedt/actions](${WORKFLOW_LINK}).`,
  ]
  const reviewerParagraph = {
    'codeowners-fallback':
      'Assigned people from CODEOWNERS as reviewers of this PR.',
    'contributors': 'Assigned repo contributors as reviewers of this PR.',
    'none': 'Could not determine who to assign as reviewers of this PR.',
  }[reviewerSource]
  if (reviewerParagraph) {
    bodyParts.push(reviewerParagraph)
  }
  const whatBullets = changes.map((change) => `- ${change.summary}`)
  bodyParts.push(`## What?\n\n${whatBullets.join('\n')}`)
  return bodyParts.join('\n\n')
}

// Everything the PR would contain, rendered into the job summary.
function renderDryRun(repoSlug, plan) {
  const lines = [
    `### ${repoSlug}`,
    '',
    '#### Title',
    '',
    PR_TITLE,
    '',
    '#### Reviewers',
    '',
    plan.reviewers.map((r) => `- ${r}`).join('\n') || '(none)',
    '',
    '#### Body',
    '',
    '<blockquote>',
    '',
    plan.prBody,
    '',
    '</blockquote>',
  ]
  for (const { change, exists, lang } of plan.files) {
    lines.push(
      '',
      `**${change.path}** (${exists ? 'update' : 'create'}):`,
      '',
      `\`\`\`${lang}`,
      change.newContent,
      '```'
    )
  }
  return `${lines.join('\n')}\n`
}

// Create the branch off `headSha`, commit the planned files, open the
// PR and request reviewers.
async function openPullRequest(ctx, headSha, plan) {
  const { octokit, org, repo, defaultBranch, log } = ctx

  // Always include run ID so each run gets a fresh branch — never
  // reuse a stale one from an earlier run whose PR was closed without
  // merging.
  const branchName = `${BRANCH_PREFIX}${ctx.runId}`
  await octokit.rest.git.createRef({
    owner: org,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: headSha,
  })

  for (const { change } of plan.files) {
    await commitChange(octokit, { org, repo, branch: branchName, change })
  }

  const pr = await octokit.rest.pulls.create({
    owner: org,
    repo,
    title: PR_TITLE,
    head: branchName,
    base: defaultBranch,
    body: plan.prBody,
  })

  const reviewerList = await requestReviewersOneByOne(octokit, {
    org,
    repo,
    pullNumber: pr.data.number,
    users: plan.reviewerUsers,
    teams: plan.reviewerTeams,
    log,
  })

  // Inline review comment on the @OWNER lines. The added lines are
  // always a contiguous block, so post a single comment spanning them
  // rather than one per line.
  if (plan.hasUnresolvedOwner) {
    await createLineComment(octokit, {
      org,
      repo,
      pr: pr.data,
      path: plan.codeownersChange.path,
      lineNumbers: plan.codeownersChange.missingLines.map(
        (ml) => ml.lineNumber
      ),
      body: 'Failed to guess who the owner should be — please replace the `@OWNER` placeholder with one or more people.',
      log,
    })
  }

  return { pr: pr.data, reviewerList }
}

// Hygiene PRs from earlier runs that are still open on the repo.
function findExistingHygienePrs(openPrs, repoSlug) {
  return openPrs.filter(
    (pr) =>
      pr.head.ref.startsWith(BRANCH_PREFIX) &&
      pr.head.repo?.full_name?.toLowerCase() === repoSlug.toLowerCase()
  )
}

function skippedResult(pr, { org, repoSlug, log }) {
  log.info(`existing hygiene PR open (${pr.html_url}), skipping`)
  return {
    repo: repoSlug,
    action: 'skipped-existing-pr',
    prUrl: pr.html_url,
    reviewers: [
      ...(pr.requested_reviewers || []).map((u) => `@${u.login}`),
      ...(pr.requested_teams || []).map((t) => `@${org}/${t.slug}`),
    ],
  }
}

/**
 * Audit one repo and, unless dry-running, open a PR fixing what it
 * finds. Returns `{ results, summary }`: the result objects for the run
 * report and, in a dry run, the markdown to append to the job summary
 * (otherwise `null`).
 *
 * `runCtx` carries what is shared across repos — `octokit`, `org`,
 * `dryRun`, `runId` and the parsed dependabot `template` — plus a
 * `log` already prefixed for this repo. The per-repo facts are added
 * to it once here, and the helpers get that one object.
 */
export async function auditRepo(runCtx, repoMeta) {
  const ctx = {
    ...runCtx,
    repo: repoMeta.name,
    repoSlug: `${runCtx.org}/${repoMeta.name}`,
    defaultBranch: repoMeta.default_branch,
  }
  const { octokit, org, repo, repoSlug, defaultBranch, dryRun, template, log } =
    ctx

  // 1. Short-circuit if hygiene PR already open
  const openPrs = await octokit.paginate(octokit.rest.pulls.list, {
    owner: org,
    repo,
    state: 'open',
    per_page: 100,
  })
  const existingHygienePrs = findExistingHygienePrs(openPrs, repoSlug)
  if (existingHygienePrs.length > 0) {
    return {
      results: existingHygienePrs.map((pr) => skippedResult(pr, ctx)),
      summary: null,
    }
  }

  // 2. Detect ecosystems & required CODEOWNERS patterns
  const { headSha, paths } = await fetchBranchTree(octokit, {
    org,
    repo,
    branch: defaultBranch,
    log,
  })
  const { detected, requiredCodeowners } = detectEcosystems(paths)

  // 3. Check existing dependabot config
  const existingDependabot = await tryGetContent(octokit, {
    owner: org,
    repo,
    paths: ['.github/dependabot.yaml', '.github/dependabot.yml'],
    ref: defaultBranch,
  })
  const dependabotChange = planDependabotChange({
    detected,
    existing: existingDependabot,
    template,
    log,
  })

  // 4. Check CODEOWNERS
  const existingCodeowners = await tryGetContent(octokit, {
    owner: org,
    repo,
    // https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners#codeowners-file-location
    paths: ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'],
    ref: defaultBranch,
  })
  const parsedLines = parseCodeowners(
    existingCodeowners ? existingCodeowners.content : ''
  )
  const missingCodeowners = requiredCodeowners.filter(
    (r) => !findOwningLine(r, parsedLines)
  )

  if (!dependabotChange && missingCodeowners.length === 0) {
    log.info('nothing to do')
    return { results: [{ repo: repoSlug, action: 'ok' }], summary: null }
  }

  // 5. Decide reviewers / OWNER substitution
  const { reviewerTokens, reviewerSource, ownerSubstitute } =
    await chooseReviewers(octokit, {
      org,
      repo,
      requiredCodeowners,
      parsedLines,
    })
  const { users: reviewerUsers, teams: reviewerTeams } =
    splitReviewers(reviewerTokens)
  const reviewers = [
    ...reviewerUsers.map((u) => `@${u}`),
    ...reviewerTeams.map((t) => `@${org}/${t}`),
  ]

  // 6. Build CODEOWNERS addition
  const codeownersChange =
    missingCodeowners.length > 0
      ? buildCodeownersAddition({
          existing: existingCodeowners,
          parsedLines,
          requiredPatterns: requiredCodeowners,
          missingPatterns: missingCodeowners,
          ownerToken: ownerSubstitute || OWNER_PLACEHOLDER,
        })
      : null
  const hasUnresolvedOwner = Boolean(codeownersChange) && !ownerSubstitute

  // 7. Compose the PR
  const plan = {
    files: planFiles([
      [dependabotChange, existingDependabot, 'yaml'],
      [codeownersChange, existingCodeowners, ''],
    ]),
    reviewers,
    reviewerUsers,
    reviewerTeams,
    reviewerSource,
    codeownersChange,
    hasUnresolvedOwner,
  }
  plan.prBody = composePrBody(plan)

  // 8. Dry run → summary; otherwise create branch + commits + PR
  if (dryRun) {
    log.info('Dry run, skipping PR creation')
    return {
      results: [
        {
          repo: repoSlug,
          action: 'dry-run',
          reviewers,
          unresolvedOwner: hasUnresolvedOwner,
        },
      ],
      summary: renderDryRun(repoSlug, plan),
    }
  }

  const { pr, reviewerList } = await openPullRequest(ctx, headSha, plan)
  log.info(`opened ${pr.html_url}`)
  return {
    results: [
      {
        repo: repoSlug,
        action: 'opened-pr',
        prUrl: pr.html_url,
        reviewers: reviewerList,
      },
    ],
    summary: null,
  }
}
