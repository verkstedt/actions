import * as core from '@actions/core'
import * as actionsGithub from '@actions/github'
import picomatch from 'picomatch'

import { auditRepo } from './lib/audit-repo.mjs'
import { loadDependabotTemplate } from './lib/dependabot-config.mjs'
import { createLogger } from './lib/log.mjs'
import { report } from './lib/report.mjs'

/**
 * Org repos to audit: sources only, skipping archived, disabled and
 * empty ones, narrowed by `reposFilter` globs when given. Returns
 * `null` after failing the run if a filter matched nothing.
 */
async function listTargetRepos(octokit, { org, reposFilter }) {
  const allRepos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    type: 'sources',
    per_page: 100,
  })

  let targets = allRepos.filter(
    (r) => !r.archived && !r.disabled && (r.size || 0) > 0
  )

  if (reposFilter.length === 0) return targets

  await core.summary
    .addRaw(
      [
        'Running only for:',
        '',
        ...reposFilter.map((f) => `- \`${f}\``),
        '',
      ].join('\n')
    )
    .write()

  // Each entry is a picomatch glob; literal names match exactly (no
  // wildcards). Lets you pass e.g. `demo-*`. Walk every target once so
  // we discover all unmatched patterns before failing — surface them
  // all at once.
  const matchers = reposFilter.map((pat) => ({
    pattern: pat,
    isMatch: picomatch(pat, { dot: true }),
  }))
  const hitPatterns = new Set()
  targets = targets.filter((r) => {
    const matched = matchers.filter((m) => m.isMatch(r.name))
    matched.forEach((m) => hitPatterns.add(m.pattern))
    return matched.length > 0
  })
  const missing = reposFilter.filter((p) => !hitPatterns.has(p))
  for (const pat of missing) {
    core.error(
      `Requested repo pattern "${pat}" matched no repos in ${org} (after filtering archived/disabled/fork/empty).`
    )
  }
  if (missing.length > 0) {
    core.setFailed(
      `Aborting: ${missing.length} requested repo pattern(s) matched nothing.`
    )
    return null
  }
  return targets
}

/**
 * Audit every repo in `targets`, one after the other. A repo whose
 * audit throws becomes a `failed` result instead of ending the run.
 * Dry-run summaries are appended to the job summary as they come.
 */
async function auditRepos(ctx, targets) {
  const results = []
  let number = 0
  for (const repoMeta of targets) {
    number += 1
    const repoSlug = `${ctx.org}/${repoMeta.name}`
    const log = createLogger(`${number}/${targets.length}. ${repoSlug}:`)
    try {
      const audit = await auditRepo({ ...ctx, log }, repoMeta)
      results.push(...audit.results)
      if (audit.summary) {
        await core.summary.addRaw(audit.summary).write()
      }
    } catch (e) {
      log.error(e.message)
      results.push({ repo: repoSlug, action: 'failed', error: e.message })
    }
  }
  return results
}

async function main() {
  const token = core.getInput('github-token', { required: true })
  const octokit = actionsGithub.getOctokit(token)
  const { context } = actionsGithub

  const org = core.getInput('org') || context.repo.owner
  const dryRun = core.getBooleanInput('dry-run')
  const reposFilter = (core.getInput('repos') || '')
    .split(/[,;\s]/)
    .map((s) => s.trim())
    .filter(Boolean)

  if (dryRun) {
    await core.summary
      .addRaw(
        '> [!NOTE]\n> This is a **dry run**. No pull requests will be created. Will show info about ones that would, here in the summary.\n\n'
      )
      .write()
  }

  // Verify App has access to all org repos
  const inst = await octokit.request('GET /installation/repositories', {
    per_page: 1,
  })
  if (inst.data.repository_selection !== 'all') {
    core.setFailed(
      `App has repository_selection='${inst.data.repository_selection}'; expected 'all'. Reconfigure the App's repository access to "All repositories".`
    )
    return
  }

  const template = await loadDependabotTemplate(octokit)

  const targets = await listTargetRepos(octokit, { org, reposFilter })
  if (!targets) return

  core.info(
    `Auditing ${targets.length} repo(s) in ${org}${dryRun ? ' (dry run)' : ''}`
  )

  const ctx = { octokit, org, dryRun, template, runId: context.runId }
  const results = await auditRepos(ctx, targets)

  const { outputs, summary } = report(results)
  for (const [name, value] of Object.entries(outputs)) {
    core.setOutput(name, value)
  }
  await core.summary.addRaw(summary).write()
}

main().catch((err) => {
  core.setFailed(err.message ?? String(err))
})
