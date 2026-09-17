import {
  applyFixes,
  BRANCH_PREFIX,
  type Applied,
  type RunOptions,
} from './apply-fixes.ts'
import { describeReviewers } from './reviewers.ts'
import { runChecks } from './run-checks.ts'
import { takeSnapshot } from './snapshot.ts'
import type {
  Check,
  Finding,
  Logger,
  Octokit,
  PullRequest,
  RepoMeta,
} from './types.ts'

export interface AuditOptions extends RunOptions {
  org: string
  checks: Array<Check>
  log: Logger
}

/** Hygiene PRs from earlier runs still open on this very repo, not a fork. */
function findHygienePrs(
  openPrs: Array<PullRequest>,
  repoSlug: string
): Array<PullRequest> {
  return openPrs.filter(
    (pr) =>
      pr.head.ref.startsWith(BRANCH_PREFIX) &&
      pr.head.repo?.full_name?.toLowerCase() === repoSlug.toLowerCase()
  )
}

function skippedFinding(
  pr: PullRequest,
  org: string,
  repoSlug: string
): Finding {
  const reviewers = [
    ...(pr.requested_reviewers || []).map((u) => `@${u.login}`),
    ...(pr.requested_teams || []).map((t) => `@${org}/${t.slug}`),
  ]
  return {
    repo: repoSlug,
    level: 'info',
    summary: 'hygiene PR already open',
    url: pr.html_url,
    outcome: {
      status: 'skipped',
      url: pr.html_url,
      detail: describeReviewers(reviewers),
    },
  }
}

/**
 * Audit one repo: snapshot it, skip PR-opening checks when a hygiene
 * PR is already open, run the checks and apply their fixes. Throws
 * when the snapshot cannot be taken or the open PRs cannot be listed.
 */
export async function auditRepo(
  octokit: Octokit,
  repoMeta: RepoMeta,
  { org, checks, log, ...run }: AuditOptions
): Promise<Applied> {
  const snapshot = await takeSnapshot(octokit, repoMeta, { org, log })
  const repoSlug = `${org}/${repoMeta.name}`

  const existing = findHygienePrs(await snapshot.listOpenPrs(), repoSlug)
  for (const pr of existing)
    log.info(`existing hygiene PR open (${pr.html_url})`)
  const skipped = existing.map((pr) => skippedFinding(pr, org, repoSlug))
  const toRun = existing.length > 0 ? checks.filter((c) => !c.opensPr) : checks

  const findings = await runChecks(toRun, snapshot)
  const applied = await applyFixes(findings, snapshot, run)
  return {
    findings: [...skipped, ...applied.findings],
    preview: applied.preview,
  }
}
