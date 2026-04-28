import * as core from '@actions/core'
import * as actionsGithub from '@actions/github'
import yaml from 'yaml'
import picomatch from 'picomatch'

const WORKFLOW_LINK =
  'https://github.com/verkstedt/actions/blob/HEAD/repo-hygiene/'
const BRANCH_PREFIX = 'chore/repo-hygiene/'
const OWNER_PLACEHOLDER = '@OWNER'
const KNOWN_BOTS = new Set(['dependabot', 'github-actions', 'renovate'])

// --- Helpers ---

function normalisePattern(p) {
  let s = String(p || '')
  if (s.startsWith('**/')) s = s.slice(3)
  if (s.startsWith('/')) s = s.slice(1)
  if (s.endsWith('/')) s = s.slice(0, -1)
  return s
}

function parseCodeowners(text) {
  const out = []
  const lines = String(text || '').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = lines[i].replace(/#.*$/, '').trim()
    if (stripped) {
      const [pattern, ...owners] = stripped.split(/\s+/)
      out.push({ pattern, owners, rawIndex: i })
    }
  }
  return out
}

function findCoveringLine(required, existingLines) {
  const reqNorm = normalisePattern(required)
  for (const line of existingLines) {
    const pat = normalisePattern(line.pattern)
    if (pat === reqNorm) return line
    if (pat === '*' || pat === '.' || pat === '') return line
    if (reqNorm.startsWith(`${pat}/`)) return line
    // Glob support via picomatch — lets entries like
    // `docker-compose.*` cover `docker-compose.yml` /
    // `docker-compose.yaml`. `dot: true` so `*` matches
    // dot-prefixed names (CODEOWNERS doesn't treat them
    // specially).
    if (pat.includes('*') && picomatch.isMatch(reqNorm, pat, { dot: true })) {
      return line
    }
  }
  return null
}

function splitReviewers(ownerTokens) {
  const users = new Set()
  const teams = new Set()
  for (const tok of ownerTokens) {
    const login = String(tok).replace(/^@/, '')
    if (login) {
      if (login.includes('/')) {
        const [, team] = login.split('/')
        if (team) teams.add(team)
      } else {
        users.add(login)
      }
    }
  }
  return {
    users: [...users].slice(0, 15),
    teams: [...teams].slice(0, 15),
  }
}

async function tryGetContent(octokit, { paths, ...params }) {
  for (const path of paths) {
    try {
      const res = await octokit.rest.repos.getContent({ ...params, path })
      if (!Array.isArray(res.data)) {
        return {
          sha: res.data.sha,
          path: res.data.path,
          content: Buffer.from(res.data.content, 'base64').toString('utf8'),
        }
      }
    } catch (e) {
      if (e.status !== 404) {
        throw e
      }
    }
  }

  return null
}

// Pick up the first quoted string scalar's style so new scalars we
// add match what's already there. Plain/block scalars are ignored —
// they don't tell us a quoting preference.
const QUOTED_TYPES = ['QUOTE_SINGLE', 'QUOTE_DOUBLE']
function inferStringType(doc) {
  let found = 'QUOTE_SINGLE'
  yaml.visit(doc, {
    Scalar(_, node) {
      if (QUOTED_TYPES.includes(node.type)) {
        found = node.type
        return yaml.visit.BREAK
      }
      return undefined
    },
  })
  return found
}

function stringifyDependabotDoc(doc) {
  return doc.toString({
    defaultKeyType: 'PLAIN',
    defaultStringType: inferStringType(doc),
    lineWidth: 120,
    aliasDuplicateObjects: false,
  })
}

// Drop `.type` from every string scalar in a node (or document) so
// `defaultStringType` decides their quoting on serialise. Use this on
// cloned template entries before splicing them into a host doc that
// uses a different quote style.
function clearScalarQuoting(node) {
  yaml.visit(node, {
    Scalar(_, scalar) {
      if (typeof scalar.value === 'string') {
        // eslint-disable-next-line no-param-reassign -- mutating the visited node is the point
        scalar.type = undefined
      }
    },
  })
}

// --- Main ---

// eslint-disable-next-line complexity -- TODO Refactor
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

  // --- Verify App has access to all org repos ---

  const inst = await octokit.request('GET /installation/repositories', {
    per_page: 1,
  })
  if (inst.data.repository_selection !== 'all') {
    core.setFailed(
      `App has repository_selection='${inst.data.repository_selection}'; expected 'all'. Reconfigure the App's repository access to "All repositories".`
    )
    return
  }

  // --- Fetch dependabot template once ---

  const templateRes = await octokit.rest.repos.getContent({
    owner: 'verkstedt',
    repo: '.github',
    path: 'templates/dependabot.yaml',
  })
  const templateText = Buffer.from(templateRes.data.content, 'base64').toString(
    'utf8'
  )
  const templateDoc = yaml.parseDocument(templateText)
  const templateUpdates = templateDoc.get('updates')
  const templateEntryByEcosystem = new Map()
  if (yaml.isSeq(templateUpdates)) {
    for (const item of templateUpdates.items) {
      templateEntryByEcosystem.set(item.get('package-ecosystem'), item)
    }
  }

  // --- List target repos ---

  const allRepos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    type: 'sources',
    per_page: 100,
  })

  let targets = allRepos.filter(
    (r) => !r.archived && !r.disabled && (r.size || 0) > 0
  )

  if (reposFilter.length > 0) {
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
    // wildcards). Lets you pass e.g. `demo-*`. Walk every target once
    // so we discover all unmatched patterns before failing — surface
    // them all at once.
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
      return
    }
  }

  core.info(
    `Auditing ${targets.length} repo(s) in ${org}${dryRun ? ' (dry run)' : ''}`
  )

  // --- Per repo ---

  const results = []

  const totalCount = targets.length
  let number = 0
  for (const repoMeta of targets) {
    number += 1
    const repo = repoMeta.name
    const repoSlug = `${org}/${repo}`
    const logPrefix = `${number}/${totalCount}. ${repoSlug}:`
    try {
      // 1. Short-circuit if hygiene PR already open
      const openPrs = await octokit.paginate(octokit.rest.pulls.list, {
        owner: org,
        repo,
        state: 'open',
        per_page: 100,
      })
      const existingHygienePrs = openPrs.filter((pr) =>
        pr.head.ref.startsWith(BRANCH_PREFIX)
      )
      if (existingHygienePrs.length > 0) {
        for (const pr of existingHygienePrs) {
          const reviewers = [
            ...(pr.requested_reviewers || []).map((u) => `@${u.login}`),
            ...(pr.requested_teams || []).map((t) => `@${org}/${t.slug}`),
          ]
          core.info(
            `${logPrefix} existing hygiene PR open (${pr.html_url}), skipping`
          )
          results.push({
            repo: repoSlug,
            action: 'skipped-existing-pr',
            prUrl: pr.html_url,
            reviewers,
          })
        }
        // eslint-disable-next-line no-continue -- TODO Refactor
        continue
      }

      // 2. Detect ecosystems & required CODEOWNERS patterns
      const defaultBranch = repoMeta.default_branch
      const refData = await octokit.rest.git.getRef({
        owner: org,
        repo,
        ref: `heads/${defaultBranch}`,
      })
      const headSha = refData.data.object.sha
      const commitData = await octokit.rest.git.getCommit({
        owner: org,
        repo,
        commit_sha: headSha,
      })
      const treeSha = commitData.data.tree.sha
      const treeData = await octokit.rest.git.getTree({
        owner: org,
        repo,
        tree_sha: treeSha,
        recursive: '1',
      })
      if (treeData.data.truncated) {
        core.warning(
          `${logPrefix} tree response truncated; detection may be incomplete`
        )
      }
      const paths = (treeData.data.tree || []).map((e) => `/${e.path}`)

      const hasFile = (predicate) => paths.some(predicate)

      const detected = new Set()
      const requiredCodeowners = []

      if (hasFile((p) => p.endsWith('/package.json'))) {
        detected.add('npm')
        if (hasFile((p) => p.endsWith('/package-lock.json'))) {
          requiredCodeowners.push('package-lock.json')
        }
        if (hasFile((p) => p.endsWith('/yarn.lock'))) {
          requiredCodeowners.push('yarn.lock')
        }
        if (hasFile((p) => p.endsWith('/pnpm-lock.yaml'))) {
          requiredCodeowners.push('pnpm-lock.yaml')
        }
      }
      if (hasFile((p) => /\/Dockerfile$/.test(p) || /\.Dockerfile$/.test(p))) {
        detected.add('docker')
        requiredCodeowners.push('Dockerfile')
      }
      const composePaths = paths.filter((p) =>
        /\/docker-compose[^/]*\.ya?ml$/.test(p)
      )
      if (composePaths.length > 0) {
        detected.add('docker-compose')
        const names = new Set(composePaths.map((p) => p.split('/').pop()))
        for (const n of [...names].sort()) {
          requiredCodeowners.push(n)
        }
      }
      if (paths.includes('/.devcontainer/devcontainer.json')) {
        detected.add('devcontainers')
        requiredCodeowners.push('/.devcontainer/devcontainer.json')
      }
      if (hasFile((p) => p.startsWith('/.github/workflows/'))) {
        detected.add('github-actions')
        requiredCodeowners.push('/.github/workflows/')
      }

      // 3. Check existing dependabot config
      const existingDependabot = await tryGetContent(octokit, {
        owner: org,
        repo,
        paths: ['.github/dependabot.yaml', '.github/dependabot.yml'],
        ref: defaultBranch,
      })

      let dependabotChange = null // null | { path, newContent, sha?, summary }

      if (detected.size === 0) {
        // No detected ecosystems — nothing to add.
      } else if (!existingDependabot) {
        // Start from a clone of the template Document so we keep its
        // header / per-entry comments. Prune entries for ecosystems
        // we didn't detect.
        const newDoc = templateDoc.clone()
        const updates = newDoc.get('updates')
        const kept = []
        if (yaml.isSeq(updates)) {
          for (let i = updates.items.length - 1; i >= 0; i -= 1) {
            const eco = updates.items[i].get('package-ecosystem')
            if (detected.has(eco)) {
              kept.unshift(eco)
            } else {
              updates.delete(i)
            }
          }
        }
        if (kept.length > 0) {
          const body = stringifyDependabotDoc(newDoc)
          dependabotChange = {
            path: '.github/dependabot.yaml',
            newContent: body,
            summary: `created \`.github/dependabot.yaml\` with sections: ${kept.map((e) => `\`${e}\``).join(', ')}`,
          }
        }
      } else {
        let parsed
        try {
          parsed = yaml.parseDocument(existingDependabot.content)
          if (parsed.errors.length > 0) {
            core.warning(
              `${logPrefix} could not parse existing dependabot file: ${parsed.errors[0].message}`
            )
            parsed = null
          }
        } catch (e) {
          core.warning(
            `${logPrefix} could not parse existing dependabot file: ${e.message}`
          )
          parsed = null
        }
        if (parsed) {
          if (parsed.get('version') == null) {
            parsed.set('version', 2)
          }
          let updates = parsed.get('updates')
          if (!yaml.isSeq(updates)) {
            updates = parsed.createNode([])
            parsed.set('updates', updates)
          }
          let changed = false
          const fixes = []

          for (const u of updates.items) {
            const eco = u.get('package-ecosystem')
            if (u.get('directory') !== '/') {
              u.set('directory', '/')
              changed = true
              fixes.push(`set \`directory: "/"\` on \`${eco}\``)
            }
            const cooldown = u.get('cooldown')
            const days = yaml.isMap(cooldown)
              ? cooldown.get('default-days')
              : undefined
            if (typeof days !== 'number' || days < 7) {
              if (yaml.isMap(cooldown)) {
                cooldown.set('default-days', 7)
              } else {
                u.set('cooldown', parsed.createNode({ 'default-days': 7 }))
              }
              changed = true
              fixes.push(`set \`cooldown.default-days: 7\` on \`${eco}\``)
            }
          }

          const existingEcos = new Set(
            updates.items.map((u) => u.get('package-ecosystem'))
          )
          const added = []
          for (const eco of detected) {
            if (!existingEcos.has(eco) && templateEntryByEcosystem.has(eco)) {
              // Clone so we don't share nodes with templateDoc; the
              // clone keeps the comments attached to the template
              // entry. Strip its scalar quoting so the spliced block
              // matches the host doc's style instead of the
              // template's.
              const cloned = templateEntryByEcosystem.get(eco).clone()
              clearScalarQuoting(cloned)
              updates.add(cloned)
              added.push(eco)
              changed = true
            }
          }

          if (changed) {
            const body = stringifyDependabotDoc(parsed)
            const parts = []
            if (added.length > 0) {
              parts.push(
                `added sections: ${added.map((e) => `\`${e}\``).join(', ')}`
              )
            }
            if (fixes.length > 0) {
              parts.push(...fixes)
            }
            dependabotChange = {
              path: existingDependabot.path,
              sha: existingDependabot.sha,
              newContent: body,
              summary: `updated \`${existingDependabot.path}\`: ${parts.join('; ')}`,
            }
          }
        }
      }

      // 4. Check CODEOWNERS
      const existingCodeowners = await tryGetContent(octokit, {
        owner: org,
        repo,
        paths: ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'],
        ref: defaultBranch,
      })
      const parsedLines = parseCodeowners(
        existingCodeowners ? existingCodeowners.content : ''
      )

      const missingCodeowners = requiredCodeowners.filter(
        (r) => !findCoveringLine(r, parsedLines)
      )

      // Early exit if nothing to do
      if (!dependabotChange && missingCodeowners.length === 0) {
        core.info(`${logPrefix} nothing to do`)
        results.push({
          repo: repoSlug,
          action: 'ok',
        })
        // eslint-disable-next-line no-continue -- TODO Refactor
        continue
      }

      // 7. Decide reviewer / OWNER substitution
      let ownerSubstitute = null
      let reviewerSource = 'none'
      const reviewerTokens = new Set()

      // 7.1 owners matched from required paths
      const matchedOwners = new Set()
      for (const req of requiredCodeowners) {
        const match = findCoveringLine(req, parsedLines)
        if (match) {
          match.owners.forEach((o) => matchedOwners.add(o))
        }
      }
      if (matchedOwners.size > 0) {
        reviewerSource = 'codeowners-match'
        matchedOwners.forEach((o) => reviewerTokens.add(o))
        // Reuse the owners from existing CODEOWNERS lines that already
        // cover required paths — they're the right owners for the new
        // lines too. Space-join when there are several, matching
        // CODEOWNERS multi-owner syntax.
        ownerSubstitute = [...matchedOwners].join(' ')
      } else {
        // 7.2 any existing CODEOWNERS entries
        const allOwners = new Set()
        for (const line of parsedLines) {
          line.owners.forEach((o) => allOwners.add(o))
        }
        if (allOwners.size > 0) {
          reviewerSource = 'codeowners-fallback'
          allOwners.forEach((o) => reviewerTokens.add(o))
        } else {
          // 7.3 contributors
          let contribs = []
          try {
            const { data } = await octokit.rest.repos.listContributors({
              owner: org,
              repo,
              per_page: 100,
            })
            contribs = Array.isArray(data) ? data : []
          } catch (e) {
            if (e.status !== 404 && e.status !== 204) {
              throw e
            }
          }
          const humans = contribs.filter(
            (c) =>
              c.type === 'User' &&
              !/\[bot\]$/.test(c.login) &&
              !KNOWN_BOTS.has(c.login)
          )
          if (humans.length > 0) {
            reviewerSource = 'contributors'
            humans.forEach((h) => reviewerTokens.add(`@${h.login}`))
          }
        }
      }

      // 6. Build CODEOWNERS addition
      let codeownersChange = null
      if (missingCodeowners.length > 0) {
        const ownerToken = ownerSubstitute || OWNER_PLACEHOLDER

        // Find the last existing line that already covers any required
        // pattern. New lines get inserted right after it (no
        // blank-line separator, no header comment) so they sit next to
        // their relatives. If no such line exists, append at the end
        // with a blank line + header.
        let insertAfterIdx = -1
        for (const req of requiredCodeowners) {
          const match = findCoveringLine(req, parsedLines)
          if (match && match.rawIndex > insertAfterIdx) {
            insertAfterIdx = match.rawIndex
          }
        }
        const includeHeader = insertAfterIdx === -1

        const addedLines = []
        if (includeHeader) {
          addedLines.push('# Make sure dependabot PRs get reviewers assigned')
        }
        for (const pat of missingCodeowners) {
          addedLines.push(`${pat}  ${ownerToken}`)
        }

        const baseText = existingCodeowners ? existingCodeowners.content : ''
        const baseLines = baseText.split('\n')
        // split on a string ending with \n leaves a trailing empty
        // element; drop it for clean splicing.
        if (baseLines.length > 0 && baseLines[baseLines.length - 1] === '') {
          baseLines.pop()
        }

        let combinedLines
        let patternStartLine // 1-indexed line of first added pattern
        if (insertAfterIdx >= 0) {
          combinedLines = [
            ...baseLines.slice(0, insertAfterIdx + 1),
            ...addedLines,
            ...baseLines.slice(insertAfterIdx + 1),
          ]
          // No header in this branch; first added line is the first
          // pattern.
          patternStartLine = insertAfterIdx + 2
        } else if (baseLines.length > 0) {
          combinedLines = [...baseLines, '', ...addedLines]
          patternStartLine =
            baseLines.length + 1 /* blank */ + (includeHeader ? 1 : 0) + 1
        } else {
          combinedLines = [...addedLines]
          patternStartLine = (includeHeader ? 1 : 0) + 1
        }

        const newContent = `${combinedLines.join('\n')}\n`

        codeownersChange = {
          path: existingCodeowners ? existingCodeowners.path : 'CODEOWNERS',
          sha: existingCodeowners ? existingCodeowners.sha : undefined,
          newContent,
          missingLines: missingCodeowners.map((pat, i) => ({
            pattern: pat,
            lineNumber: patternStartLine + i,
            ownerToken,
          })),
          addedLines,
          summary: existingCodeowners
            ? `added ${missingCodeowners.length} line(s) to \`${existingCodeowners.path}\`: ${missingCodeowners.map((p) => `\`${p}\``).join(', ')}`
            : `created \`CODEOWNERS\` with ${missingCodeowners.length} line(s): ${missingCodeowners.map((p) => `\`${p}\``).join(', ')}`,
        }
      }

      // 8. Compose PR body
      const bodyParts = [
        `🤖 Opened automatically by [repo-hygiene action from verkstedt/actions](${WORKFLOW_LINK}).`,
      ]
      const reviewerParagraph = {
        'codeowners-fallback':
          'Assigned people from CODEOWNERS as reviewers of this PR.',
        'contributors': 'Assigned repo contributors as reviewers of this PR.',
        'none': 'Could not determine who to assign as reviewers of this PR.',
      }[reviewerSource]
      if (reviewerParagraph) {
        bodyParts.push(reviewerParagraph)
      }
      const whatBullets = [dependabotChange, codeownersChange]
        .filter(Boolean)
        .map((change) => `- ${change.summary}`)
      bodyParts.push(`## What?\n\n${whatBullets.join('\n')}`)
      const prBody = bodyParts.join('\n\n')

      // 9 / 10. Dry run → log; otherwise create branch + commits + PR
      const { users: reviewerUsers, teams: reviewerTeams } =
        splitReviewers(reviewerTokens)
      const hasUnresolvedOwner =
        codeownersChange && !ownerSubstitute && missingCodeowners.length > 0

      if (dryRun) {
        core.info(`${logPrefix} Dry run, skipping PR creation`)

        const lines = [
          `### ${repoSlug}`,
          '',
          '#### Title',
          '',
          'chore: Repo hygiene',
          '',
          '#### Reviewers',
          '',
          [
            ...reviewerUsers.map((u) => `- @${u}`),
            ...reviewerTeams.map((t) => `- @${org}/${t}`),
          ].join('\n') || '(none)',
          '',
          '#### Body',
          '',
          '<blockquote>',
          '',
          prBody,
          '',
          '</blockquote>',
        ]
        if (dependabotChange) {
          lines.push(
            '',
            `**${dependabotChange.path}** (${existingDependabot ? 'update' : 'create'}):`,
            '',
            '```yaml',
            dependabotChange.newContent,
            '```'
          )
        }
        if (codeownersChange) {
          lines.push(
            '',
            `**${codeownersChange.path}** (${existingCodeowners ? 'update' : 'create'}):`,
            '',
            '```',
            codeownersChange.newContent,
            '```'
          )
        }
        await core.summary.addRaw(`${lines.join('\n')}\n`).write()
        results.push({
          repo: repoSlug,
          action: 'dry-run',
          reviewers: [
            ...reviewerUsers,
            ...reviewerTeams.map((t) => `${org}/${t}`),
          ],
          unresolvedOwner: hasUnresolvedOwner,
        })
        // eslint-disable-next-line no-continue -- TODO Refactor
        continue
      }

      // Create branch. Always include run ID so each run gets a fresh
      // branch — never reuse a stale one from an earlier run whose PR
      // was closed without merging.
      const branchName = `${BRANCH_PREFIX}${context.runId}`
      await octokit.rest.git.createRef({
        owner: org,
        repo,
        ref: `refs/heads/${branchName}`,
        sha: headSha,
      })

      // Commit files
      if (dependabotChange) {
        await octokit.rest.repos.createOrUpdateFileContents({
          owner: org,
          repo,
          branch: branchName,
          path: dependabotChange.path,
          message: dependabotChange.sha
            ? `chore: Update ${dependabotChange.path}`
            : `chore: Add ${dependabotChange.path}`,
          content: Buffer.from(dependabotChange.newContent, 'utf8').toString(
            'base64'
          ),
          sha: dependabotChange.sha,
        })
      }
      if (codeownersChange) {
        await octokit.rest.repos.createOrUpdateFileContents({
          owner: org,
          repo,
          branch: branchName,
          path: codeownersChange.path,
          message: codeownersChange.sha
            ? `chore: Update ${codeownersChange.path}`
            : `chore: Add ${codeownersChange.path}`,
          content: Buffer.from(codeownersChange.newContent, 'utf8').toString(
            'base64'
          ),
          sha: codeownersChange.sha,
        })
      }

      // Open PR
      const pr = await octokit.rest.pulls.create({
        owner: org,
        repo,
        title: 'chore: Repo hygiene',
        head: branchName,
        base: defaultBranch,
        body: prBody,
      })

      // Request reviewers
      const reviewerList = []
      if (reviewerUsers.length > 0 || reviewerTeams.length > 0) {
        try {
          await octokit.rest.pulls.requestReviewers({
            owner: org,
            repo,
            pull_number: pr.data.number,
            reviewers: reviewerUsers,
            team_reviewers: reviewerTeams,
          })
          reviewerList.push(...reviewerUsers.map((u) => `@${u}`))
          reviewerList.push(...reviewerTeams.map((t) => `@${org}/${t}`))
        } catch (e) {
          core.warning(`${logPrefix} could not request reviewers: ${e.message}`)
        }
      }

      // Inline review comment on the @OWNER lines. The added lines are
      // always a contiguous block, so post a single comment spanning
      // them rather than one per line.
      if (hasUnresolvedOwner) {
        const lineNumbers = codeownersChange.missingLines.map(
          (ml) => ml.lineNumber
        )
        const startLine = Math.min(...lineNumbers)
        const endLine = Math.max(...lineNumbers)
        const comment = {
          path: codeownersChange.path,
          body: 'Failed to guess who the owner should be — please replace the `@OWNER` placeholder with one or more people.',
          side: 'RIGHT',
          line: endLine,
        }
        if (startLine !== endLine) {
          comment.start_line = startLine
          comment.start_side = 'RIGHT'
        }
        try {
          await octokit.rest.pulls.createReview({
            owner: org,
            repo,
            pull_number: pr.data.number,
            commit_id: pr.data.head.sha,
            event: 'COMMENT',
            comments: [comment],
          })
        } catch (e) {
          core.warning(
            `${logPrefix} could not create review comment: ${e.message}`
          )
        }
      }

      core.info(`${logPrefix} opened ${pr.data.html_url}`)
      results.push({
        repo: repoSlug,
        action: 'opened-pr',
        prUrl: pr.data.html_url,
        reviewers: reviewerList,
      })
    } catch (e) {
      core.error(`${logPrefix} ${e.message}`)
      results.push({
        repo: repoSlug,
        action: 'failed',
        error: e.message,
      })
    }
  }

  // --- Summarise ---

  core.setOutput('results_json', JSON.stringify(results))

  const opened = results.filter((r) => r.action === 'opened-pr')
  const failed = results.filter((r) => r.action === 'failed')
  const dryRuns = results.filter((r) => r.action === 'dry-run')
  const preexisting = results.filter((r) => r.action === 'skipped-existing-pr')

  const reviewerSummary = (r) =>
    r.reviewers && r.reviewers.length > 0
      ? `reviewer(s): ${r.reviewers.join(', ')}`
      : 'no reviewer assigned'

  const lines = []
  if (opened.length > 0) {
    lines.push(
      '',
      'Opened PRs:',
      ...opened.map(
        (r, idx) => `${idx + 1}. <${r.prUrl}> — ${reviewerSummary(r)}`
      )
    )
  }
  if (preexisting.length > 0) {
    lines.push(
      '',
      'Pre-existing PRs:',
      ...preexisting.map(
        (r, idx) => `${idx + 1}. <${r.prUrl}> — ${reviewerSummary(r)}`
      )
    )
  }
  if (dryRuns.length > 0) {
    lines.push(
      '',
      'Would open PRs (dry run):',
      ...dryRuns.map(
        (r, idx) => `${idx + 1}. ${r.repo} — ${reviewerSummary(r)}`
      )
    )
  }
  if (failed.length > 0) {
    lines.push(
      '',
      'Failed repos:',
      ...failed.map((r, idx) => `${idx + 1}. ${r.repo} — ${r.error}`)
    )
  }

  core.setOutput('slack_text', lines.join('\n'))
  core.setOutput(
    'should_notify',
    opened.length + failed.length > 0 ? 'true' : 'false'
  )
  core.setOutput('slack_status', failed.length > 0 ? 'failure' : 'warning')

  await core.summary
    .addRaw(
      [
        '',
        '## Summary',
        '',
        `\`repo-hygiene\` run complete (${results.length} repo(s) checked)`,
        '',
        ...lines,
        '',
      ].join('\n')
    )
    .write()
}

main().catch((err) => {
  core.setFailed(err.message ?? String(err))
})
