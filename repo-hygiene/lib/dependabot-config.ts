import yaml from 'yaml'
import { errorMessage, tryGetContent } from './github.ts'
import type { Document, Scalar, YAMLMap, YAMLSeq } from 'yaml'

import type {
  Change,
  DependabotTemplate,
  FileContent,
  Logger,
  Octokit,
} from './types.ts'

// Pick up the first quoted string scalar’s style so new scalars we
// add match what’s already there. Plain/block scalars are ignored —
// they don’t tell us a quoting preference.
const QUOTED_TYPES: Array<Scalar.Type> = ['QUOTE_SINGLE', 'QUOTE_DOUBLE']
function inferStringType(doc: Document): Scalar.Type {
  let found: Scalar.Type = 'QUOTE_SINGLE'
  yaml.visit(doc, {
    Scalar(_, node) {
      if (node.type && QUOTED_TYPES.includes(node.type)) {
        found = node.type
        return yaml.visit.BREAK
      }
      return undefined
    },
  })
  return found
}

function stringifyDependabotDoc(doc: Document): string {
  return doc.toString({
    defaultKeyType: 'PLAIN',
    defaultStringType: inferStringType(doc),
    lineWidth: 120,
  })
}

// Drop `.type` from every string scalar in a node (or document) so
// `defaultStringType` decides their quoting on serialise. Use this on
// cloned template entries before splicing them into a host doc that
// uses a different quote style.
function clearScalarQuoting(node: Parameters<typeof yaml.visit>[0]): void {
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
export function parseDependabotTemplate(text: string): DependabotTemplate {
  const doc = yaml.parseDocument(text)
  const updates = doc.get('updates')
  const entryByEcosystem = new Map<string, YAMLMap>()
  if (yaml.isSeq(updates)) {
    for (const item of updates.items) {
      if (yaml.isMap(item)) {
        entryByEcosystem.set(String(item.get('package-ecosystem')), item)
      }
    }
  }
  return { doc, entryByEcosystem }
}

// Sorted unique basenames of `paths` whose basename matches `re`.
// CODEOWNERS matches a bare name at any depth, so one line per
// distinct name covers every copy of it.
function basenamesMatching(paths: Array<string>, re: RegExp): Array<string> {
  const names = new Set(
    paths.map((p) => p.split('/').pop() ?? '').filter((name) => re.test(name))
  )
  return [...names].sort()
}

/**
 * Fetch and parse the org-wide dependabot template, once per run. The
 * template missing is fatal: nothing sensible can be added without it.
 */
export async function loadDependabotTemplate(
  octokit: Octokit
): Promise<DependabotTemplate> {
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
export function detectEcosystems(paths: Array<string>): {
  detected: Set<string>
  requiredCodeowners: Array<string>
} {
  const hasFile = (predicate: (path: string) => boolean) =>
    paths.some(predicate)

  const detected = new Set<string>()
  const requiredCodeowners: Array<string> = []

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
  // Dependabot matches “dockerfile” or “containerfile” anywhere in the
  // file name, case-insensitively. Cover the names people actually use:
  // `Dockerfile`, `Dockerfile.worker`, `base.Dockerfile`, `Containerfile`.
  const dockerfileNames = basenamesMatching(
    paths,
    /^(dockerfile|containerfile)(\.|$)|\.(dockerfile|containerfile)$/i
  )
  if (dockerfileNames.length > 0) {
    detected.add('docker')
    requiredCodeowners.push(...dockerfileNames)
  }
  const composeNames = basenamesMatching(paths, /^docker-compose.*\.ya?ml$/)
  if (composeNames.length > 0) {
    detected.add('docker-compose')
    requiredCodeowners.push(...composeNames)
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

// The `package-ecosystem` of an `updates` entry, or `undefined`.
function ecosystemOf(entry: unknown): string | undefined {
  if (!yaml.isMap(entry)) return undefined
  const eco: unknown = entry.get('package-ecosystem')
  return typeof eco === 'string' ? eco : undefined
}

// Start from a clone of the template Document so we keep its header /
// per-entry comments. Prune entries for ecosystems we didn’t detect.
function createFromTemplate(
  template: DependabotTemplate,
  detected: Set<string>
): Change | null {
  const newDoc = template.doc.clone()
  const updates = newDoc.get('updates')
  const kept: Array<string> = []
  if (yaml.isSeq(updates)) {
    for (let i = updates.items.length - 1; i >= 0; i -= 1) {
      const eco = ecosystemOf(updates.items[i])
      if (eco !== undefined && detected.has(eco)) {
        kept.unshift(eco)
      } else {
        updates.delete(i)
      }
    }
  }
  if (kept.length === 0) return null
  return {
    path: '.github/dependabot.yaml',
    newContent: stringifyDependabotDoc(newDoc),
    summary: `created \`.github/dependabot.yaml\` with sections: ${kept.map((e) => `\`${e}\``).join(', ')}`,
  }
}

function parseExisting(existing: FileContent, log: Logger): Document | null {
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
    log.warning(`could not parse existing dependabot file: ${errorMessage(e)}`)
    return null
  }
}

// Make every `updates` entry wait at least 7 days before proposing a
// new version. Returns a description of each fix made.
function ensureCooldowns(parsed: Document, updates: YAMLSeq): Array<string> {
  const fixes: Array<string> = []
  for (const u of updates.items.filter((item) => yaml.isMap(item))) {
    const eco = ecosystemOf(u)
    const cooldown = u.get('cooldown')
    const days: unknown = yaml.isMap(cooldown)
      ? cooldown.get('default-days')
      : undefined
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

// Append template entries for `detected` ecosystems `updates` lacks.
// Returns the ecosystems added.
function addMissingEcosystems(
  updates: YAMLSeq,
  template: DependabotTemplate,
  detected: Set<string>
): Array<string> {
  const existingEcos = new Set(updates.items.map(ecosystemOf))
  const added: Array<string> = []
  for (const eco of detected) {
    const templateEntry = template.entryByEcosystem.get(eco)
    if (!existingEcos.has(eco) && templateEntry) {
      // Clone so we don’t share nodes with the template doc; the clone
      // keeps the comments attached to the template entry. Strip its
      // scalar quoting so the spliced block matches the host doc’s
      // style instead of the template’s.
      const cloned = templateEntry.clone() as YAMLMap
      clearScalarQuoting(cloned)
      updates.add(cloned)
      added.push(eco)
    }
  }
  return added
}

// Add missing ecosystems from the template, set a missing `version`
// and enforce a cooldown on every entry. Returns null when the file is
// fine, unparseable, or has an `updates` that is not a list.
function updateExisting(
  existing: FileContent,
  template: DependabotTemplate,
  detected: Set<string>,
  log: Logger
): Change | null {
  const parsed = parseExisting(existing, log)
  if (!parsed) return null

  const fixes: Array<string> = []
  if (parsed.get('version') == null) {
    parsed.set('version', 2)
    fixes.push('set `version: 2`')
  }
  let updates = parsed.get('updates')
  if (updates == null) {
    updates = parsed.createNode([])
    parsed.set('updates', updates)
  }
  if (!yaml.isSeq(updates)) {
    log.warning('existing dependabot file has a non-list `updates`, skipping')
    return null
  }

  fixes.push(...ensureCooldowns(parsed, updates))
  const added = addMissingEcosystems(updates, template, detected)
  if (fixes.length === 0 && added.length === 0) return null

  const parts: Array<string> = []
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

interface PlanDependabotParams {
  detected: Set<string>
  existing: FileContent | null
  template: DependabotTemplate
  log: Logger
}

/**
 * The change to make to a repo’s dependabot config, or `null` when
 * nothing needs doing. `existing` is the current file as returned by
 * `tryGetContent`, or `null`. Problems that are not fatal go to `log`.
 */
export function planDependabotChange({
  detected,
  existing,
  template,
  log,
}: PlanDependabotParams): Change | null {
  if (detected.size === 0) {
    // No detected ecosystems — nothing to add.
    return null
  }
  if (!existing) {
    return createFromTemplate(template, detected)
  }
  return updateExisting(existing, template, detected, log)
}
