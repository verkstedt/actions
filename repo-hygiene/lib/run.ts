import { auditRepo } from './audit-repo.ts';
import { codeowners } from './checks/codeowners.ts';
import { dependabotConfig } from './checks/dependabot-config.ts';
import { dependabotReviewers } from './checks/dependabot-reviewers.ts';
import { repoSettings } from './checks/repo-settings.ts';
import {
  assertAppSeesAllRepos,
  getErrorMessage,
  listTargetRepos,
} from './github.ts';
import { createLogger } from './log.ts';
import type { Check, Finding, GitHub, LogSink, Octokit } from './types.ts';

/** Every check the action runs, in order. */
export const allChecks: Array<Check> = [
  repoSettings,
  dependabotReviewers,
  dependabotConfig,
  codeowners,
];

/** Only whitespace, so commas in brace globs like `{a,b}` survive. */
const REPOS_SEPARATOR_RE = /\s+/;

/** Repo globs from a whitespace-separated list. */
export function parseReposFilter(value: string): Array<string> {
  return value.split(REPOS_SEPARATOR_RE).filter(Boolean);
}

export interface RunAuditOptions {
  org: string;
  dryRun: boolean;
  /** Whitespace-separated picomatch globs narrowing the repos; empty means every repo. */
  repos: string;
  runId: number;
  runAttempt: number;
  /** Fail unless the token is an App installation that sees every repo. */
  requireAppAccess: boolean;
  log: LogSink;
  checks?: Array<Check>;
}

export interface RunAuditResult {
  findings: Array<Finding>;
  /** Rendered dry-run PRs, one per repo that would get one. */
  previews: Array<string>;
  repoCount: number;
  /** The globs parsed from `repos`. */
  reposFilter: Array<string>;
}

function createFailedRepoFinding(
  org: string,
  repoMeta: GitHub.RepoMeta,
  error: unknown,
): Finding {
  return {
    repo: `${org}/${repoMeta.name}`,
    level: 'error',
    summary: 'could not audit repo',
    details: [getErrorMessage(error)],
    outcome: { status: 'none' },
  };
}

/**
 * Audit every target repo of the org with the checks. A repo whose
 * audit throws becomes one error finding and the run carries on.
 */
export async function runAudit(
  octokit: Octokit,
  {
    org,
    dryRun,
    repos: reposInput,
    runId,
    runAttempt,
    requireAppAccess,
    log,
    checks = allChecks,
  }: RunAuditOptions,
): Promise<RunAuditResult> {
  if (requireAppAccess) {
    await assertAppSeesAllRepos(octokit);
  }
  const reposFilter = parseReposFilter(reposInput);
  const repos = await listTargetRepos(octokit, { org, reposFilter });
  for (const check of checks) {
    await check.setup?.(octokit);
  }
  createLogger({}, log).info(
    `Auditing ${repos.length} repo(s) in ${org}${dryRun ? ' (dry run)' : ''}`,
  );

  const findings: Array<Finding> = [];
  const previews: Array<string> = [];
  for (const [index, repoMeta] of repos.entries()) {
    const repoLog = createLogger(
      {
        repo: { name: repoMeta.name, position: index + 1, total: repos.length },
      },
      log,
    );
    try {
      const audited = await auditRepo(octokit, repoMeta, {
        org,
        dryRun,
        runId,
        runAttempt,
        checks,
        log: repoLog,
      });
      findings.push(...audited.findings);
      if (audited.preview) {
        previews.push(audited.preview);
      }
    } catch (error) {
      repoLog.error(getErrorMessage(error));
      findings.push(createFailedRepoFinding(org, repoMeta, error));
    }
  }

  return { findings, previews, repoCount: repos.length, reposFilter };
}
