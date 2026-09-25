import { getErrorMessage } from './github.ts'
import { createLogger } from './log.ts'
import type { RepoSnapshot } from './snapshot.ts'
import type { Check, CheckFinding, Finding } from './types.ts'

function normalise(path: string): string {
  return path.replace(/^\//, '')
}

/**
 * Attach the finding’s file fix to the working copy, or mark the
 * finding failed when it would blindly overwrite a pending fix:
 * either the check never read the path, or it already fixed it.
 */
function acceptFileFix(
  finding: Finding,
  check: Check,
  snapshot: RepoSnapshot,
  fixedByThisCheck: Set<string>
): void {
  if (finding.fix?.kind !== 'file') {
    return
  }
  const path = normalise(finding.fix.path)
  const { pending, reads } = snapshot.workingCopy
  const blind = pending.has(path) && !reads.has(path)
  if (blind || fixedByThisCheck.has(path)) {
    // eslint-disable-next-line no-param-reassign -- stamping the outcome onto the finding is the point
    finding.outcome = {
      status: 'failed',
      detail: `${check.name} check changed ${path} without reading the pending fix for it`,
    }
  } else {
    snapshot.workingCopy.attach(path, finding.fix.content)
    fixedByThisCheck.add(path)
  }
}

function createErrorFinding(
  check: Check,
  error: unknown,
  snapshot: RepoSnapshot
): Finding {
  const message = getErrorMessage(error)
  snapshot.log.error(`check failed: ${message}`)
  return {
    repo: `${snapshot.org}/${snapshot.repo}`,
    check: check.name,
    level: 'error',
    summary: `${check.name} check failed`,
    details: [message],
  }
}

/**
 * Run `checks` in order against `snapshot`. Each check logs under its
 * own name and each finding gets its `repo` and `check`; file fixes
 * become the working copy later checks read. A check that throws
 * yields one error finding and the rest still run.
 */
export async function runChecks(
  checks: Array<Check>,
  snapshot: RepoSnapshot
): Promise<Array<Finding>> {
  const repo = `${snapshot.org}/${snapshot.repo}`
  const findings: Array<Finding> = []
  for (const check of checks) {
    snapshot.workingCopy.startCheck()
    const checkSnapshot: RepoSnapshot = {
      ...snapshot,
      log: createLogger({ check: check.name }, snapshot.log),
    }
    let found: Array<CheckFinding> | undefined
    try {
      found = await check.run(checkSnapshot)
    } catch (error) {
      findings.push(createErrorFinding(check, error, checkSnapshot))
    }
    if (found !== undefined) {
      const fixedByThisCheck = new Set<string>()
      for (const checkFinding of found) {
        const finding: Finding = { repo, check: check.name, ...checkFinding }
        acceptFileFix(finding, check, snapshot, fixedByThisCheck)
        findings.push(finding)
      }
    }
  }
  return findings
}
