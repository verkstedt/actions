import * as core from '@actions/core'
import * as actionsGithub from '@actions/github'

import { getErrorMessage } from './lib/github.ts'
import { actionsLogger } from './lib/log.ts'
import { publish } from './lib/report.ts'
import { runAudit } from './lib/run.ts'

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

  const { findings, previews, repoCount } = await runAudit(octokit, {
    org: inputs.org,
    dryRun: inputs.dryRun,
    reposFilter: inputs.reposFilter,
    runId: inputs.runId,
    runAttempt: inputs.runAttempt,
    requireAppAccess: true,
    log: actionsLogger,
  })

  await publish(findings, { repoCount, dryRun: inputs.dryRun, previews })
}

main().catch((error: unknown) => core.setFailed(getErrorMessage(error)))
