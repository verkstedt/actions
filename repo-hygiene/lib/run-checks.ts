import { errorMessage } from './github.ts'
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
  if (finding.fix?.kind !== 'file') return
  const path = normalise(finding.fix.path)
  const { pending, reads } = snapshot.workingCopy
  const blind = pending.has(path) && !reads.has(path)
  if (blind || fixedByThisCheck.has(path)) {
    // eslint-disable-next-line no-param-reassign -- stamping the outcome onto the finding is the point
    finding.outcome = {
      status: 'failed',
      detail: `${check.name} check changed ${path} without reading the pending fix for it`,
    }
    return
  }
  snapshot.workingCopy.attach(path, finding.fix.content)
  fixedByThisCheck.add(path)
}

function errorFinding(
  check: Check,
  e: unknown,
  snapshot: RepoSnapshot
): Finding {
  const message = errorMessage(e)
  snapshot.log.error(`${check.name} check failed: ${message}`)
  return {
    repo: `${snapshot.org}/${snapshot.repo}`,
    level: 'error',
    summary: `${check.name} check failed`,
    details: [message],
  }
}

/**
 * Run `checks` in order against `snapshot`. Each finding gets its
 * `repo`; file fixes become the working copy later checks read. A
 * check that throws yields one error finding and the rest still run.
 */
export async function runChecks(
  checks: Array<Check>,
  snapshot: RepoSnapshot
): Promise<Array<Finding>> {
  const repo = `${snapshot.org}/${snapshot.repo}`
  const findings: Array<Finding> = []
  for (const check of checks) {
    snapshot.workingCopy.startCheck()
    let found: Array<CheckFinding> | undefined
    try {
      found = await check.run(snapshot)
    } catch (e) {
      findings.push(errorFinding(check, e, snapshot))
    }
    if (found !== undefined) {
      const fixedByThisCheck = new Set<string>()
      for (const checkFinding of found) {
        const finding: Finding = { repo, ...checkFinding }
        acceptFileFix(finding, check, snapshot, fixedByThisCheck)
        findings.push(finding)
      }
    }
  }
  return findings
}
