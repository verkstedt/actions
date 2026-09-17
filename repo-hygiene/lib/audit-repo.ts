import {
  parseCodeowners,
  findOwningLine,
  buildCodeownersAddition,
} from './codeowners.ts'
import { detectEcosystems, planDependabotChange } from './dependabot-config.ts'
import {
  tryGetContent,
  fetchBranchTree,
  commitChange,
  createLineComment,
  errorMessage,
} from './github.ts'
import {
  chooseReviewers,
  splitReviewers,
  requestReviewersOneByOne,
} from './reviewers.ts'
import type {
  Change,
  CodeownersChange,
  FileContent,
  PullRequest,
  RepoContext,
  RepoMeta,
  Result,
  ReviewerSource,
  RunContext,
} from './types.ts'

const WORKFLOW_LINK =
  'https://github.com/verkstedt/actions/blob/HEAD/repo-hygiene/'
// Also how PRs from earlier runs are recognised, so renaming it makes
// the action reopen PRs on every repo that already has one.
const BRANCH_PREFIX = 'chore/repo-hygiene/'
const OWNER_PLACEHOLDER = '@OWNER'
const PR_TITLE = 'chore: Repo hygiene'

interface PlannedFile {
  change: Change
  exists: boolean
  lang: string
}

/** Everything the hygiene PR for one repo would contain. */
interface PrPlan {
  files: Array<PlannedFile>
  reviewers: Array<string>
  reviewerUsers: Array<string>
  reviewerTeams: Array<string>
  reviewerSource: ReviewerSource
  codeownersChange: CodeownersChange | null
  hasUnresolvedOwner: boolean
  prBody: string
}

type FileCandidate = [Change | null, FileContent | null, string]

// `[change, existingFile, codeFenceLang]` triples → the files the PR
// commits, skipping changes that are null.
function planFiles(candidates: Array<FileCandidate>): Array<PlannedFile> {
  return candidates.flatMap(([change, existing, lang]) =>
    change ? [{ change, exists: Boolean(existing), lang }] : []
  )
}

function composePrBody({
  reviewerSource,
  files,
}: Pick<PrPlan, 'reviewerSource' | 'files'>): string {
  const changes = files.map((f) => f.change)
  const bodyParts = [
    `🤖 Opened automatically by [repo-hygiene action from verkstedt/actions](${WORKFLOW_LINK}).`,
  ]
  const reviewerParagraph: Partial<Record<ReviewerSource, string>> = {
    'codeowners-fallback':
      'Assigned people from CODEOWNERS as reviewers of this PR.',
    'contributors': 'Assigned repo contributors as reviewers of this PR.',
    'none': 'Could not determine who to assign as reviewers of this PR.',
  }
  const paragraph = reviewerParagraph[reviewerSource]
  if (paragraph) {
    bodyParts.push(paragraph)
  }
  const whatBullets = changes.map((change) => `- ${change.summary}`)
  bodyParts.push(`## What?\n\n${whatBullets.join('\n')}`)
  return bodyParts.join('\n\n')
}

// Everything the PR would contain, rendered into the job summary.
function renderDryRun(repoSlug: string, plan: PrPlan): string {
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
async function openPullRequest(
  ctx: RepoContext,
  headSha: string,
  plan: PrPlan
): Promise<{ pr: PullRequest; reviewerList: Array<string> }> {
  const { octokit, org, repo, defaultBranch, log } = ctx

  // Always include run ID and attempt so each run gets a fresh branch —
  // never reuse a stale one from an earlier run whose PR was closed
  // without merging, or from a failed attempt of this run.
  const branchName = `${BRANCH_PREFIX}${ctx.runId}-${ctx.runAttempt}`
  await octokit.rest.git.createRef({
    owner: org,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: headSha,
  })

  for (const { change } of plan.files) {
    await commitChange(octokit, {
      org,
      repo,
      branch: branchName,
      path: change.path,
      content: change.newContent,
      sha: change.sha,
    })
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
  if (plan.hasUnresolvedOwner && plan.codeownersChange) {
    try {
      await createLineComment(octokit, {
        org,
        repo,
        pr: pr.data,
        path: plan.codeownersChange.path,
        lineNumbers: plan.codeownersChange.missingLines.map(
          (ml) => ml.lineNumber
        ),
        body: 'Failed to guess who the owner should be — please replace the `@OWNER` placeholder with one or more people.',
      })
    } catch (e) {
      log.warning(`could not create review comment: ${errorMessage(e)}`)
    }
  }

  return { pr: pr.data, reviewerList }
}

// Hygiene PRs from earlier runs that are still open on the repo.
function findExistingHygienePrs(
  openPrs: Array<PullRequest>,
  repoSlug: string
): Array<PullRequest> {
  return openPrs.filter(
    (pr) =>
      pr.head.ref.startsWith(BRANCH_PREFIX) &&
      pr.head.repo?.full_name?.toLowerCase() === repoSlug.toLowerCase()
  )
}

function skippedResult(
  pr: PullRequest,
  { org, repoSlug, log }: RepoContext
): Result {
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

/** What `auditRepo` returns for one repo. */
export interface RepoAudit {
  results: Array<Result>
  summary: string | null
}

/**
 * Audit one repo and, unless dry-running, open a PR fixing what it
 * finds. Returns `{ results, summary }`: the result objects for the run
 * report and, in a dry run, the markdown to append to the job summary
 * (otherwise `null`).
 *
 * `runCtx` carries what is shared across repos — `octokit`, `org`,
 * `dryRun`, `runId`, `runAttempt` and the parsed dependabot `template` —
 * plus a `log` already prefixed for this repo. The per-repo facts are
 * added to it once here, and the helpers get that one object.
 */
export async function auditRepo(
  runCtx: RunContext & Pick<RepoContext, 'log'>,
  repoMeta: RepoMeta
): Promise<RepoAudit> {
  const ctx: RepoContext = {
    ...runCtx,
    repo: repoMeta.name,
    repoSlug: `${runCtx.org}/${repoMeta.name}`,
    defaultBranch: repoMeta.default_branch,
  }
  const { octokit, org, repo, repoSlug, defaultBranch, dryRun, template, log } =
    ctx

  // 1. Short-circuit if hygiene PR already open
  const openPrs: Array<PullRequest> = await octokit.paginate(
    octokit.rest.pulls.list,
    {
      owner: org,
      repo,
      state: 'open',
      per_page: 100,
    }
  )
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
  const files = planFiles([
    [dependabotChange, existingDependabot, 'yaml'],
    [codeownersChange, existingCodeowners, ''],
  ])
  const plan: PrPlan = {
    files,
    reviewers,
    reviewerUsers,
    reviewerTeams,
    reviewerSource,
    codeownersChange,
    hasUnresolvedOwner,
    prBody: composePrBody({ reviewerSource, files }),
  }

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
