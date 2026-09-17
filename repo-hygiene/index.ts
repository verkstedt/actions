import * as core from '@actions/core'
import * as actionsGithub from '@actions/github'

import { auditRepo } from './lib/audit-repo.ts'
import { codeowners } from './lib/checks/codeowners.ts'
import { dependabotConfig } from './lib/checks/dependabot-config.ts'
import {
  assertAppSeesAllRepos,
  getErrorMessage,
  listTargetRepos,
} from './lib/github.ts'
import { createLogger } from './lib/log.ts'
import { publish } from './lib/report.ts'
import type { Check, Finding, GitHub } from './lib/types.ts'

const checks: Array<Check> = [dependabotConfig, codeowners]

const DRY_RUN_NOTE =
  '> [!NOTE]\n> This is a **dry run**. No pull requests will be created. Will show info about ones that would, here in the summary.\n\n'

function readInputs() {
  const { context } = actionsGithub
  return {
    token: core.getInput('github-token', { required: true }),
    org: core.getInput('org') || context.repo.owner,
    dryRun: core.getBooleanInput('dry-run'),
    reposFilter: (core.getInput('repos') || '').split(/[,;\s]/).filter(Boolean),
    runId: context.runId,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) || 1,
  }
}

function createFailedRepoFinding(
  org: string,
  repoMeta: GitHub.RepoMeta,
  e: unknown
): Finding {
  return {
    repo: `${org}/${repoMeta.name}`,
    level: 'error',
    summary: 'could not audit repo',
    details: [getErrorMessage(e)],
    outcome: { status: 'none' },
  }
}

async function main(): Promise<void> {
  const inputs = readInputs()
  const octokit = actionsGithub.getOctokit(inputs.token)

  if (inputs.dryRun) {
    await core.summary.addRaw(DRY_RUN_NOTE).write()
  }
  if (inputs.reposFilter.length > 0) {
    await core.summary
      .addRaw(
        [
          'Running only for:',
          '',
          ...inputs.reposFilter.map((f) => `- \`${f}\``),
          '',
        ].join('\n')
      )
      .write()
  }

  await assertAppSeesAllRepos(octokit)
  const repos = await listTargetRepos(octokit, {
    org: inputs.org,
    reposFilter: inputs.reposFilter,
  })
  for (const check of checks) {
    await check.setup?.(octokit)
  }
  core.info(
    `Auditing ${repos.length} repo(s) in ${inputs.org}${inputs.dryRun ? ' (dry run)' : ''}`
  )

  const findings: Array<Finding> = []
  const previews: Array<string> = []
  for (const [index, repoMeta] of repos.entries()) {
    const log = createLogger(
      `${index + 1}/${repos.length}. ${inputs.org}/${repoMeta.name}:`
    )
    try {
      const audited = await auditRepo(octokit, repoMeta, {
        org: inputs.org,
        dryRun: inputs.dryRun,
        runId: inputs.runId,
        runAttempt: inputs.runAttempt,
        checks,
        log,
      })
      findings.push(...audited.findings)
      if (audited.preview) {
        previews.push(audited.preview)
      }
    } catch (e) {
      log.error(getErrorMessage(e))
      findings.push(createFailedRepoFinding(inputs.org, repoMeta, e))
    }
  }

  await publish(findings, {
    repoCount: repos.length,
    dryRun: inputs.dryRun,
    previews,
  })
}

main().catch((e: unknown) => core.setFailed(getErrorMessage(e)))
