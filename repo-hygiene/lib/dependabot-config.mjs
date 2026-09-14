import yaml from 'yaml'

import { tryGetContent } from './github.mjs'

// Pick up the first quoted string scalar’s style so new scalars we
// add match what’s already there. Plain/block scalars are ignored —
// they don’t tell us a quoting preference.
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

/**
 * Drop `.type` from every string scalar in a node (or document) so
 * `defaultStringType` decides their quoting on serialise. Use this on
 * cloned template entries before splicing them into a host doc that
 * uses a different quote style.
 */
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

/**
 * Parse the org-wide dependabot template into `{ doc, entryByEcosystem }`,
 * where `entryByEcosystem` maps `package-ecosystem` to its `updates`
 * entry node.
 */
export function parseDependabotTemplate(text) {
  const doc = yaml.parseDocument(text)
  const updates = doc.get('updates')
  const entryByEcosystem = new Map()
  if (yaml.isSeq(updates)) {
    for (const item of updates.items) {
      entryByEcosystem.set(item.get('package-ecosystem'), item)
    }
  }
  return { doc, entryByEcosystem }
}

/**
 * Fetch and parse the org-wide dependabot template, once per run. The
 * template missing is fatal: nothing sensible can be added without it.
 */
export async function loadDependabotTemplate(octokit) {
  const file = await tryGetContent(octokit, {
    owner: 'verkstedt',
    repo: '.github',
    paths: ['templates/dependabot.yaml'],
  })
  if (!file) {
    throw new Error('verkstedt/.github has no templates/dependabot.yaml')
  }
  return parseDependabotTemplate(file.content)
}

/**
 * Which dependabot ecosystems a repo uses, judged from the paths in
 * its tree (each prefixed with `/`), and the CODEOWNERS patterns that
 * must have an owner so the resulting Dependabot PRs get reviewers.
 */
export function detectEcosystems(paths) {
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

  return { detected, requiredCodeowners }
}

/**
 * Start from a clone of the template Document so we keep its header /
 * per-entry comments. Prune entries for ecosystems we didn’t detect.
 */
function createFromTemplate(template, detected) {
  const newDoc = template.doc.clone()
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
  if (kept.length === 0) {
    return null
  }
  return {
    path: '.github/dependabot.yaml',
    newContent: stringifyDependabotDoc(newDoc),
    summary: `created \`.github/dependabot.yaml\` with sections: ${kept.map((e) => `\`${e}\``).join(', ')}`,
  }
}

function parseExisting(existing, log) {
  try {
    const parsed = yaml.parseDocument(existing.content)
    if (parsed.errors.length > 0) {
      log.warning(
        `could not parse existing dependabot file: ${parsed.errors[0].message}`
      )
      return null
    }
    return parsed
  } catch (e) {
    log.warning(`could not parse existing dependabot file: ${e.message}`)
    return null
  }
}

/**
 * Make every `updates` entry wait at least 7 days before proposing a
 * new version. Returns a description of each fix made.
 */
function ensureCooldowns(parsed, updates) {
  const fixes = []
  for (const u of updates.items) {
    const eco = u.get('package-ecosystem')
    const cooldown = u.get('cooldown')
    const days = yaml.isMap(cooldown) ? cooldown.get('default-days') : undefined
    if (typeof days !== 'number' || days < 7) {
      if (yaml.isMap(cooldown)) {
        cooldown.set('default-days', 7)
      } else {
        u.set('cooldown', parsed.createNode({ 'default-days': 7 }))
      }
      fixes.push(`set \`cooldown.default-days: 7\` on \`${eco}\``)
    }
  }
  return fixes
}

/**
 * Append template entries for `detected` ecosystems `updates` lacks.
 * Returns the ecosystems added.
 */
function addMissingEcosystems(updates, template, detected) {
  const existingEcos = new Set(
    updates.items.map((u) => u.get('package-ecosystem'))
  )
  const added = []
  for (const eco of detected) {
    if (!existingEcos.has(eco) && template.entryByEcosystem.has(eco)) {
      // Clone so we don’t share nodes with the template doc; the clone
      // keeps the comments attached to the template entry. Strip its
      // scalar quoting so the spliced block matches the host doc’s
      // style instead of the template’s.
      const cloned = template.entryByEcosystem.get(eco).clone()
      clearScalarQuoting(cloned)
      updates.add(cloned)
      added.push(eco)
    }
  }
  return added
}

// Add missing ecosystems from the template and enforce a cooldown on
// every entry. Returns null when the file is fine or unparseable.
function updateExisting(existing, template, detected, log) {
  const parsed = parseExisting(existing, log)
  if (!parsed) {
    return null
  }

  if (parsed.get('version') == null) {
    parsed.set('version', 2)
  }
  let updates = parsed.get('updates')
  if (!yaml.isSeq(updates)) {
    updates = parsed.createNode([])
    parsed.set('updates', updates)
  }

  const fixes = ensureCooldowns(parsed, updates)
  const added = addMissingEcosystems(updates, template, detected)
  if (fixes.length === 0 && added.length === 0) {
    return null
  }

  const parts = []
  if (added.length > 0) {
    parts.push(`added sections: ${added.map((e) => `\`${e}\``).join(', ')}`)
  }
  parts.push(...fixes)
  return {
    path: existing.path,
    sha: existing.sha,
    newContent: stringifyDependabotDoc(parsed),
    summary: `updated \`${existing.path}\`: ${parts.join('; ')}`,
  }
}

/**
 * The change to make to a repo’s dependabot config, or `null` when
 * nothing needs doing. `existing` is the current file as returned by
 * `tryGetContent`, or `null`. Problems that are not fatal go to `log`.
 */
export function planDependabotChange({ detected, existing, template, log }) {
  if (detected.size === 0) {
    // No detected ecosystems — nothing to add.
    return null
  }
  if (!existing) {
    return createFromTemplate(template, detected)
  }
  return updateExisting(existing, template, detected, log)
}
