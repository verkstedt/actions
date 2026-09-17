import { parseCodeowners } from './codeowners.ts'
import { commitChange, getErrorMessage } from './github.ts'
import {
  CODEOWNERS_PATHS,
  chooseReviewers,
  describeReviewers,
  requestReviewersOneByOne,
  formatReviewerHandles,
  splitReviewers,
} from './reviewers.ts'
import type { RepoSnapshot } from './snapshot.ts'
import type {
  ActionFix,
  FileFix,
  Finding,
  GitHub,
  ReviewerSource,
} from './types.ts'

const WORKFLOW_LINK =
  'https://github.com/verkstedt/actions/blob/HEAD/repo-hygiene/'
/** Also how PRs from earlier runs are recognised. */
export const BRANCH_PREFIX = 'chore/repo-hygiene/'
export const PR_TITLE = 'chore: Repo hygiene'

export interface RunOptions {
  dryRun: boolean
  runId: number
  runAttempt: number
}

export interface Applied {
  findings: Array<Finding>
  /** The rendered PR for the job summary, in a dry run. */
  preview: string | null
}

type FileFinding = Finding & { fix: FileFix }
type ActionFinding = Finding & { fix: ActionFix }

const isPending = (f: Finding) => f.outcome === undefined
const hasFileFix = (f: Finding): f is FileFinding => f.fix?.kind === 'file'
const hasActionFix = (f: Finding): f is ActionFinding =>
  f.fix?.kind === 'action'

function normalise(path: string): string {
  return path.replace(/^\//, '')
}

/** One entry per path, the last fix’s content winning. */
function collectFinalFiles(findings: Array<FileFinding>): Map<string, string> {
  const files = new Map<string, string>()
  for (const { fix } of findings) {
    files.set(normalise(fix.path), fix.content)
  }
  return files
}

const REVIEWER_PARAGRAPHS: Partial<Record<ReviewerSource, string>> = {
  'codeowners-fallback':
    'Assigned people from CODEOWNERS as reviewers of this PR.',
  'contributors': 'Assigned repo contributors as reviewers of this PR.',
  'none': 'Could not determine who to assign as reviewers of this PR.',
}

function composePrBody(
  reviewerSource: ReviewerSource,
  describes: Array<string>
): string {
  const parts = [
    `> [!NOTE]\n> 🤖 Opened automatically by [repo-hygiene action from verkstedt/actions](${WORKFLOW_LINK}). Merge after approving.`,
  ]
  const paragraph = REVIEWER_PARAGRAPHS[reviewerSource]
  if (paragraph) {
    parts.push(paragraph)
  }
  parts.push('## What?', `${describes.map((d) => `- ${d}`).join('\n')}`)
  return parts.join('\n\n')
}

async function readCommittedCodeowners(snapshot: RepoSnapshot) {
  for (const path of CODEOWNERS_PATHS) {
    const file = await snapshot.readFileOnDefaultBranch(path)
    if (file) {
      return parseCodeowners(file.content)
    }
  }
  return []
}

interface PrPlan {
  files: Map<string, string>
  /** Code fence language per path, from the last fix for it. */
  langs: Map<string, string>
  describes: Array<string>
  reviewers: { users: Array<string>; teams: Array<string> }
  reviewerHandles: Array<string>
  body: string
}

function collectSuggestedReviewers(
  fileFindings: Array<FileFinding>,
  findings: Array<Finding>
): Array<string> {
  return findings
    .filter(
      (f) => f.reviewers && (fileFindings.includes(f as FileFinding) || !f.fix)
    )
    .flatMap((f) => f.reviewers ?? [])
}

async function planPr(
  fileFindings: Array<FileFinding>,
  findings: Array<Finding>,
  snapshot: RepoSnapshot
): Promise<PrPlan> {
  const { reviewerTokens, reviewerSource } = await chooseReviewers(
    snapshot.octokit,
    {
      org: snapshot.org,
      repo: snapshot.repo,
      suggested: collectSuggestedReviewers(fileFindings, findings),
      parsedLines: await readCommittedCodeowners(snapshot),
    }
  )
  const reviewers = splitReviewers(reviewerTokens)
  const describes = fileFindings.map((f) => f.fix.describe)
  return {
    files: collectFinalFiles(fileFindings),
    langs: new Map(
      fileFindings.map((f) => [normalise(f.fix.path), f.fix.lang])
    ),
    describes,
    reviewers,
    reviewerHandles: formatReviewerHandles(snapshot.org, reviewers),
    body: composePrBody(reviewerSource, describes),
  }
}

async function renderFilePreview(
  path: string,
  content: string,
  plan: PrPlan,
  snapshot: RepoSnapshot
): Promise<Array<string>> {
  const existing = await snapshot.readFileOnDefaultBranch(path)
  return [
    '',
    `**${path}** (${existing ? 'update' : 'create'}):`,
    '',
    `\`\`\`${plan.langs.get(path) ?? ''}`,
    content,
    '```',
  ]
}

async function renderPrPreview(
  plan: PrPlan,
  snapshot: RepoSnapshot
): Promise<string> {
  const lines = [
    `### \`${snapshot.org}/${snapshot.repo}\`: ${PR_TITLE}`,
    '',
    'Reviewers:',
    '',
    plan.reviewerHandles.map((r) => `- ${r}`).join('\n') || '- (none)',
    '',
    '<details>',
    '<summary>Body and files</summary>',
    '',
    '<blockquote>',
    '',
    plan.body,
    '',
    '</blockquote>',
    '',
    '---',
  ]
  for (const [path, content] of plan.files) {
    lines.push(...(await renderFilePreview(path, content, plan, snapshot)))
  }
  lines.push('', '</details>', '')
  return lines.join('\n')
}

async function commitPlanFiles(
  plan: PrPlan,
  snapshot: RepoSnapshot,
  branch: string
): Promise<void> {
  const { octokit, org, repo } = snapshot
  for (const [path, content] of plan.files) {
    const existing = await snapshot.readFileOnDefaultBranch(path)
    await commitChange(octokit, {
      org,
      repo,
      branch,
      path,
      content,
      sha: existing?.sha,
    })
  }
}

async function openPr(
  plan: PrPlan,
  snapshot: RepoSnapshot,
  run: RunOptions
): Promise<{ pr: GitHub.PullRequest; requested: Array<string> }> {
  const { octokit, org, repo, defaultBranch, headSha, log } = snapshot
  // Run ID and attempt make every run use a fresh branch.
  const branch = `${BRANCH_PREFIX}${run.runId}-${run.runAttempt}`
  await octokit.rest.git.createRef({
    owner: org,
    repo,
    ref: `refs/heads/${branch}`,
    sha: headSha,
  })
  await commitPlanFiles(plan, snapshot, branch)
  const pr = await octokit.rest.pulls.create({
    owner: org,
    repo,
    title: PR_TITLE,
    head: branch,
    base: defaultBranch,
    body: plan.body,
  })
  const requested = await requestReviewersOneByOne(octokit, {
    org,
    repo,
    pullNumber: pr.data.number,
    users: plan.reviewers.users,
    teams: plan.reviewers.teams,
    log,
  })
  log.info(`opened ${pr.data.html_url}`)
  return { pr: pr.data, requested }
}

function createActionOutcome(
  fix: ActionFix,
  result: Awaited<ReturnType<ActionFix['run']>>
): Finding['outcome'] {
  if (typeof result === 'object' && result !== null) {
    return { status: 'none', detail: result.detail }
  }
  return { status: 'fixed', detail: result || fix.describe }
}

async function runAction(
  finding: ActionFinding,
  snapshot: RepoSnapshot,
  pr: GitHub.PullRequest | null,
  files: Record<string, string>
): Promise<Finding['outcome']> {
  const { fix } = finding
  if (fix.afterPr && !pr) {
    return { status: 'failed', detail: 'hygiene PR was not opened' }
  }
  try {
    const result = await fix.run({
      octokit: snapshot.octokit,
      org: snapshot.org,
      repo: snapshot.repo,
      pr,
      files,
      log: snapshot.log,
    })
    return createActionOutcome(fix, result)
  } catch (e) {
    return { status: 'failed', detail: getErrorMessage(e) }
  }
}

interface FileFixesApplied {
  pr: GitHub.PullRequest | null
  files: Record<string, string>
  preview: string | null
}

async function applyFileFixes(
  fileFindings: Array<FileFinding>,
  findings: Array<Finding>,
  snapshot: RepoSnapshot,
  run: RunOptions
): Promise<FileFixesApplied> {
  if (fileFindings.length === 0) {
    return { pr: null, files: {}, preview: null }
  }

  const plan = await planPr(fileFindings, findings, snapshot)
  const files = Object.fromEntries(plan.files)

  if (run.dryRun) {
    snapshot.log.info('Dry run, skipping PR creation')
    const preview = await renderPrPreview(plan, snapshot)
    for (const f of fileFindings) {
      f.outcome = { status: 'would-fix', detail: f.fix.describe }
    }
    return { pr: null, files, preview }
  }

  try {
    const { pr, requested } = await openPr(plan, snapshot, run)
    for (const f of fileFindings) {
      f.outcome = {
        status: 'fixed',
        url: pr.html_url,
        detail: describeReviewers(requested),
      }
    }
    return { pr, files, preview: null }
  } catch (e) {
    const detail = getErrorMessage(e)
    for (const f of fileFindings) {
      f.outcome = { status: 'failed', detail }
    }
    return { pr: null, files, preview: null }
  }
}

interface ActionFixesContext {
  snapshot: RepoSnapshot
  run: RunOptions
  pr: GitHub.PullRequest | null
  files: Record<string, string>
}

async function applyActionFixes(
  findings: Array<Finding>,
  { snapshot, run, pr, files }: ActionFixesContext
): Promise<void> {
  for (const finding of findings.filter(isPending).filter(hasActionFix)) {
    if (run.dryRun) {
      finding.outcome = { status: 'would-fix', detail: finding.fix.describe }
    } else {
      finding.outcome = await runAction(finding, snapshot, pr, files)
    }
  }
}

/**
 * Give every finding an outcome: compose one PR from the file fixes
 * (or render it in a dry run), then run the action fixes, `afterPr`
 * ones with the PR. Findings that already carry an outcome are left
 * as they are.
 */
export async function applyFixes(
  findings: Array<Finding>,
  snapshot: RepoSnapshot,
  run: RunOptions
): Promise<Applied> {
  const fileFindings = findings.filter(isPending).filter(hasFileFix)
  const { pr, files, preview } = await applyFileFixes(
    fileFindings,
    findings,
    snapshot,
    run
  )

  await applyActionFixes(findings, { snapshot, run, pr, files })

  for (const finding of findings.filter(isPending)) {
    finding.outcome = { status: 'none' }
    snapshot.log.info(finding.summary)
  }
  return { findings, preview }
}
