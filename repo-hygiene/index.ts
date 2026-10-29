import * as core from '@actions/core';
import * as actionsGithub from '@actions/github';

import { getErrorMessage } from './lib/github.ts';
import { formatLogLine } from './lib/log.ts';
import { hasFailures, publish } from './lib/report.ts';
import { runAudit } from './lib/run.ts';
import type { LogSink } from './lib/types.ts';

/** Logs through the workflow commands GitHub Actions renders. */
const actionsLog: LogSink = (entry) => {
  // eslint-disable-next-line import-x/namespace -- TypeScript ensures every `LogLevel` is a `core` export.
  core[entry.level](formatLogLine(entry));
};

const DRY_RUN_NOTE =
  '> [!NOTE]\n> This is a **dry run**. No pull requests will be created and no reviewers will be requested. Will show info about ones that would, here in the summary.\n\n';

function readInputs() {
  const { context } = actionsGithub;
  return {
    token: core.getInput('github-token', { required: true }),
    org: core.getInput('org') || context.repo.owner,
    dryRun: core.getBooleanInput('dry-run'),
    repos: core.getInput('repos'),
    runId: context.runId,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) || 1,
  };
}

async function main(): Promise<void> {
  const inputs = readInputs();
  const octokit = actionsGithub.getOctokit(inputs.token);

  if (inputs.dryRun) {
    await core.summary.addRaw(DRY_RUN_NOTE).write();
  }

  const { findings, previews, repoCount, reposFilter } = await runAudit(
    octokit,
    {
      org: inputs.org,
      dryRun: inputs.dryRun,
      repos: inputs.repos,
      runId: inputs.runId,
      runAttempt: inputs.runAttempt,
      requireAppAccess: true,
      log: actionsLog,
    },
  );

  if (reposFilter.length > 0) {
    await core.summary
      .addRaw(
        [
          'Running only for:',
          '',
          ...reposFilter.map((f) => `- \`${f}\``),
          '',
        ].join('\n'),
      )
      .write();
  }

  await publish(findings, { repoCount, dryRun: inputs.dryRun, previews });
  if (hasFailures(findings)) {
    core.setFailed('Some repos failed; see the summary.');
  }
}

main().catch((error: unknown) => {
  core.setFailed(getErrorMessage(error));
});
