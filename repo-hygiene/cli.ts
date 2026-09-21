#!/usr/bin/env -S node --experimental-strip-types

import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

import { getOctokit } from '@actions/github'

import { getErrorMessage } from './lib/github.ts'
import { formatLogPrefix } from './lib/log.ts'
import { report } from './lib/report.ts'
import { runAudit } from './lib/run.ts'
import type { LogSink } from './lib/types.ts'

const HELP = `Usage: repo-hygiene --org <org> [--repos <glob>[,<glob>…]]…

Audit the org’s repos the way the GitHub Action does, as a dry run:
nothing is created or requested. Prints the progress, then the job
summary the action would write, pull requests it would open included.

The GitHub token comes from $GITHUB_TOKEN, or from \`gh auth token\`.

Options:
  --org <org>      GitHub organisation to audit (required)
  --repos <globs>  Only repos matching these picomatch globs; repeatable.
                   Single-quote them to avoid shell expansion.
  -h, --help       Show this help

Exit status is 1 when a repo could not be audited or a check failed.
`

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    repos: { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  process.stdout.write(HELP)
  process.exit(0) // EX_OK
}
if (!values.org) {
  process.stderr.write(HELP)
  process.exit(64) // EX_USAGE
}

function readGhToken(): string | undefined {
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

const token = process.env.GITHUB_TOKEN || readGhToken()
if (!token) {
  process.stderr.write(
    'No GitHub token: set GITHUB_TOKEN or log in with `gh auth login`.\n'
  )
  process.exit(64) // EX_USAGE
}

const LEVEL_LABELS = { info: '', warning: 'WARNING: ', error: 'ERROR: ' }

/**
 * `1/3. repo, check: WARNING: message`, the context dimmed on a TTY.
 * Info goes to stdout, warnings and errors to stderr.
 */
const log: LogSink = (entry) => {
  const stream = entry.level === 'info' ? process.stdout : process.stderr
  const prefix = formatLogPrefix(entry)
  const dim = (text: string) => (stream.isTTY ? `\x1b[2m${text}\x1b[22m` : text)
  const context = prefix ? `${dim(`${prefix}:`)} ` : ''
  stream.write(`${context}${LEVEL_LABELS[entry.level]}${entry.message}\n`)
}

try {
  const { findings, previews, repoCount } = await runAudit(getOctokit(token), {
    org: values.org,
    dryRun: true,
    reposFilter: (values.repos ?? []).flatMap((globs) =>
      globs.split(',').filter(Boolean)
    ),
    runId: 0,
    runAttempt: 0,
    requireAppAccess: false,
    log,
  })
  const { summary } = report(findings, { repoCount, dryRun: true, previews })
  process.stdout.write(`${summary}\n`)
  const failed = findings.some(
    (finding) =>
      finding.level === 'error' || finding.outcome?.status === 'failed'
  )
  process.exitCode = failed ? 1 : 0
} catch (error) {
  process.stderr.write(`ERROR: ${getErrorMessage(error)}\n`)
  process.exitCode = 1
}
