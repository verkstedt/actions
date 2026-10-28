import { posix } from 'node:path';

import yaml from 'yaml';
import type { Document, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';

import { getErrorMessage, tryGetContent } from './github.ts';
import { TEMPLATE_REPO } from './templates.ts';
import type {
  Change,
  DependabotTemplate,
  FileContent,
  Logger,
  Octokit,
} from './types.ts';

// Pick up the first quoted string scalar’s style so new scalars we
// add match what’s already there. Plain/block scalars are ignored —
// they don’t tell us a quoting preference.
const QUOTED_TYPES: Array<Scalar.Type> = ['QUOTE_SINGLE', 'QUOTE_DOUBLE'];
function inferStringType(doc: Document): Scalar.Type {
  let found: Scalar.Type = 'QUOTE_SINGLE';
  yaml.visit(doc, {
    Scalar(_, node) {
      if (node.type && QUOTED_TYPES.includes(node.type)) {
        found = node.type;
        return yaml.visit.BREAK;
      }
      return undefined;
    },
  });
  return found;
}

function stringifyDependabotDoc(doc: Document): string {
  return doc.toString({
    defaultKeyType: 'PLAIN',
    defaultStringType: inferStringType(doc),
    lineWidth: 120,
  });
}

/**
 * Drop `.type` from every string scalar in a node (or document) so
 * `defaultStringType` decides their quoting on serialise. Use this on
 * cloned template entries before splicing them into a host doc that
 * uses a different quote style.
 */
function clearScalarQuoting(node: Parameters<typeof yaml.visit>[0]): void {
  yaml.visit(node, {
    Scalar(_, scalar) {
      if (typeof scalar.value === 'string') {
        scalar.type = undefined;
      }
    },
  });
}

/**
 * Parse the org-wide dependabot template into `{ doc, entryByEcosystem }`,
 * where `entryByEcosystem` maps `package-ecosystem` to its `updates`
 * entry node.
 */
export function parseDependabotTemplate(text: string): DependabotTemplate {
  const doc = yaml.parseDocument(text);
  const updates = doc.get('updates');
  const entryByEcosystem = new Map<string, YAMLMap>();
  if (yaml.isSeq(updates)) {
    for (const item of updates.items) {
      if (yaml.isMap(item)) {
        entryByEcosystem.set(String(item.get('package-ecosystem')), item);
      }
    }
  }
  return { doc, entryByEcosystem };
}

/**
 * Sorted unique basenames of `paths`. CODEOWNERS matches a bare name
 * at any depth, so one line per distinct name covers every copy of it.
 */
function listUniqueBasenames(paths: Array<string>): Array<string> {
  return [...new Set(paths.map((p) => posix.basename(p)))].toSorted();
}

/**
 * Fetch and parse the org-wide dependabot template, once per run. The
 * template missing is fatal: nothing sensible can be added without it.
 */
export async function loadDependabotTemplate(
  octokit: Octokit,
): Promise<DependabotTemplate> {
  const file = await tryGetContent(octokit, {
    ...TEMPLATE_REPO,
    paths: ['templates/dependabot.yaml'],
  });
  if (!file) {
    throw new Error('verkstedt/.github has no templates/dependabot.yaml');
  }
  return parseDependabotTemplate(file.content);
}

/**
 * An ecosystem a repo uses, the directories its manifests are in and
 * the CODEOWNERS patterns it requires.
 */
interface DetectedEcosystem {
  ecosystem: string;
  manifestDirs: Set<string>;
  requiredCodeowners: Array<string>;
}

/**
 * `ecosystem` when any of `paths` has a basename matching `re`,
 * requiring an owner for each distinct name found.
 */
function detectEcosystem(
  paths: Array<string>,
  ecosystem: string,
  re: RegExp,
): DetectedEcosystem | null {
  const manifestPaths = paths.filter((p) => re.test(posix.basename(p)));
  if (manifestPaths.length === 0) {
    return null;
  }
  return {
    ecosystem,
    manifestDirs: new Set(manifestPaths.map((p) => posix.dirname(p))),
    requiredCodeowners: listUniqueBasenames(manifestPaths),
  };
}

/** `npm`, when the repo has an npm, Yarn or pnpm lockfile. */
function detectNpmEcosystem(paths: Array<string>): DetectedEcosystem | null {
  return detectEcosystem(
    paths,
    'npm',
    /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/,
  );
}

/** `cargo`, when the repo has a `Cargo.lock`. */
function detectCargoEcosystem(paths: Array<string>): DetectedEcosystem | null {
  return detectEcosystem(paths, 'cargo', /^Cargo\.lock$/);
}

/**
 * `pip`, when the repo has `requirements*.txt` or `.in` files.
 *
 * Dependabot’s `pip` ecosystem also understands other manifests and
 * lockfiles (Pipenv, Poetry, `pyproject.toml`, `setup.py`, …); only this
 * subset is supported, to keep things simple.
 */
function detectPipEcosystem(paths: Array<string>): DetectedEcosystem | null {
  return detectEcosystem(paths, 'pip', /^requirements.*\.(txt|in)$/);
}

/**
 * `docker`, when the repo has a Dockerfile.
 *
 * Dependabot matches “dockerfile” or “containerfile” anywhere in the
 * file name, case-insensitively. Cover the names people actually use:
 * `Dockerfile`, `Dockerfile.worker`, `base.Dockerfile`, `Containerfile`.
 */
function detectDockerEcosystem(paths: Array<string>): DetectedEcosystem | null {
  return detectEcosystem(
    paths,
    'docker',
    /^(dockerfile|containerfile)(\.|$)|\.(dockerfile|containerfile)$/i,
  );
}

/**
 * `docker-compose`, when the repo has a compose file, e.g.
 * `compose.yaml`, `docker-compose.yml` or `docker-compose.prod.yaml`.
 */
function detectDockerComposeEcosystem(
  paths: Array<string>,
): DetectedEcosystem | null {
  return detectEcosystem(
    paths,
    'docker-compose',
    /^(docker-)?compose([.-].*)?\.ya?ml$/,
  );
}

/**
 * Which dependabot ecosystems a repo uses, judged from the paths in
 * its tree (each prefixed with `/`), the CODEOWNERS patterns that
 * must have an owner so the resulting Dependabot PRs get reviewers,
 * and, for ecosystems found by their manifests, the directories those
 * manifests are in.
 */
export function detectEcosystems(paths: Array<string>): {
  detected: Set<string>;
  manifestDirsByEcosystem: Map<string, Set<string>>;
  requiredCodeowners: Array<string>;
} {
  const detected = new Set<string>();
  const manifestDirsByEcosystem = new Map<string, Set<string>>();
  const requiredCodeowners: Array<string> = [];

  for (const found of [
    detectNpmEcosystem(paths),
    detectCargoEcosystem(paths),
    detectPipEcosystem(paths),
    detectDockerEcosystem(paths),
    detectDockerComposeEcosystem(paths),
  ]) {
    if (found) {
      detected.add(found.ecosystem);
      manifestDirsByEcosystem.set(found.ecosystem, found.manifestDirs);
      requiredCodeowners.push(...found.requiredCodeowners);
    }
  }
  if (paths.includes('/.devcontainer/devcontainer.json')) {
    detected.add('devcontainers');
    requiredCodeowners.push('/.devcontainer/devcontainer.json');
  }
  if (paths.some((p) => p.startsWith('/.github/workflows/'))) {
    detected.add('github-actions');
    requiredCodeowners.push('/.github/workflows/');
  }

  return { detected, manifestDirsByEcosystem, requiredCodeowners };
}

/** The `package-ecosystem` of an `updates` entry, or `undefined`. */
function readEcosystem(entry: unknown): string | undefined {
  if (!yaml.isMap(entry)) {
    return undefined;
  }
  const eco: unknown = entry.get('package-ecosystem');
  return typeof eco === 'string' ? eco : undefined;
}

/**
 * Start from a clone of the template Document so we keep its header /
 * per-entry comments. Prune entries for ecosystems we didn’t detect.
 */
function createFromTemplate(
  template: DependabotTemplate,
  detected: Set<string>,
): Change | null {
  const newDoc = template.doc.clone();
  const updates = newDoc.get('updates');
  const kept: Array<string> = [];
  if (yaml.isSeq(updates)) {
    for (let i = updates.items.length - 1; i >= 0; i -= 1) {
      const eco = readEcosystem(updates.items[i]);
      if (eco !== undefined && detected.has(eco)) {
        kept.unshift(eco);
      } else {
        updates.delete(i);
      }
    }
  }
  if (kept.length === 0) {
    return null;
  }
  return {
    path: '.github/dependabot.yaml',
    newContent: stringifyDependabotDoc(newDoc),
    summary: `created \`.github/dependabot.yaml\` with sections: ${kept.map((e) => `\`${e}\``).join(', ')}`,
  };
}

function parseExisting(existing: FileContent, log: Logger): Document | null {
  try {
    const parsed = yaml.parseDocument(existing.content);
    if (parsed.errors.length > 0) {
      log.warning(
        `could not parse existing dependabot file: ${parsed.errors[0].message}`,
      );
      return null;
    }
    return parsed;
  } catch (e) {
    log.warning(
      `could not parse existing dependabot file: ${getErrorMessage(e)}`,
    );
    return null;
  }
}

/**
 * Make every `updates` entry wait at least 7 days before proposing a
 * new version.
 *
 * @param updates The `updates` list. Mutated.
 * @returns A description of each fix made.
 */
function ensureCooldowns(parsed: Document, updates: YAMLSeq): Array<string> {
  const fixes: Array<string> = [];
  for (const u of updates.items.filter((item) => yaml.isMap(item))) {
    const eco = readEcosystem(u);
    const cooldown = u.get('cooldown');
    const days: unknown = yaml.isMap(cooldown)
      ? cooldown.get('default-days')
      : undefined;
    if (typeof days !== 'number' || days < 7) {
      if (yaml.isMap(cooldown)) {
        cooldown.set('default-days', 7);
      } else {
        u.set('cooldown', parsed.createNode({ 'default-days': 7 }));
      }
      fixes.push(`set \`cooldown.default-days: 7\` on \`${eco}\``);
    }
  }
  return fixes;
}

/** Keys of an `updates` entry that say where its manifests are. */
const DIRECTORY_KEYS = ['directory', 'directories'];

/** Whether `pair` is a `directory` or `directories` key. */
function isDirectoryPair(pair: Pair): boolean {
  return (
    yaml.isScalar(pair.key) && DIRECTORY_KEYS.includes(String(pair.key.value))
  );
}

/** The `directory` / `directories` pairs of `entry`, serialised for comparison. */
function serialiseDirectoryPairs(entry: YAMLMap): string {
  return JSON.stringify(
    entry.items
      .filter(isDirectoryPair)
      .map((pair): [string, unknown] => [
        String(pair.key),
        yaml.isNode(pair.value) ? pair.value.toJSON() : pair.value,
      ]),
  );
}

/**
 * Every `directory` / `directories` pattern of `entry`, with a leading
 * and without a trailing slash, e.g. `web/` becomes `/web`.
 */
function listDirectoryPatterns(entry: YAMLMap): Array<string> {
  const directories: unknown = entry.get('directories');
  const patterns = yaml.isSeq(directories)
    ? directories.items.map((item) => (yaml.isScalar(item) ? item.value : item))
    : [entry.get('directory')];
  return patterns
    .filter((p): p is string => typeof p === 'string')
    .map((p) => `/${p}`.replace(/^\/+/, '/').replace(/(.)\/+$/, '$1'));
}

/**
 * Whether `entry` covers `dir`. A `directory` is a path, only
 * `directories` take globs.
 */
function isDirectoryCovered(entry: YAMLMap, dir: string): boolean {
  const isGlob = yaml.isSeq(entry.get('directories'));
  return listDirectoryPatterns(entry).some((pattern) =>
    isGlob ? posix.matchesGlob(dir, pattern) : dir === pattern,
  );
}

/** `a`, `a and b`, `a, b and c`. */
function formatList(items: Array<string>): string {
  return items.length < 2
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * Give every entry the `directory` / `directories` of its template
 * entry. Entries of one ecosystem and target branch get merged into the
 * first one, since with the template’s directories they would overlap.
 *
 * @param updates The `updates` list. Mutated.
 * @returns A description of each fix made, and of each merge, which
 *   reviewers should double-check.
 */
function ensureTemplateDirectories(
  updates: YAMLSeq,
  template: DependabotTemplate,
  manifestDirsByEcosystem: Map<string, Set<string>>,
  defaultBranch: string,
): { fixes: Array<string>; merges: Array<string> } {
  const fixes: Array<string> = [];
  const merges: Array<string> = [];
  const groups = Map.groupBy(
    updates.items.filter((item) => yaml.isMap(item)),
    (entry) =>
      JSON.stringify([
        readEcosystem(entry),
        entry.get('target-branch') ?? defaultBranch,
      ]),
  );
  for (const entries of groups.values()) {
    const [u, ...rest] = entries;
    const eco = readEcosystem(u);
    const templateEntry = eco ? template.entryByEcosystem.get(eco) : undefined;
    if (!templateEntry) {
      continue;
    }

    // Keep entries that together already cover every manifest, to open
    // fewer PRs.
    const manifestDirs = eco ? manifestDirsByEcosystem.get(eco) : undefined;
    const patterns = entries.flatMap((entry) => listDirectoryPatterns(entry));
    if (
      !manifestDirs ||
      [...manifestDirs].every((dir) =>
        entries.some((entry) => isDirectoryCovered(entry, dir)),
      )
    ) {
      continue;
    }

    if (rest.length > 0) {
      const removed = new Set<unknown>(rest);
      updates.items = updates.items.filter((item) => !removed.has(item));
      merges.push(
        `merged \`${eco}\` entries for ${formatList(patterns.map((p) => `\`${p}\``))} into one`,
      );
    }

    const before = serialiseDirectoryPairs(u);
    // Swap in the template’s pairs where the first old one was, so the
    // key keeps its place in the entry.
    const templatePairs = templateEntry.items
      .filter(isDirectoryPair)
      .map((pair) => {
        const cloned = pair.clone();
        if (yaml.isNode(cloned.value)) {
          clearScalarQuoting(cloned.value);
        }
        return cloned;
      });
    const index = u.items.findIndex(isDirectoryPair);
    u.items = u.items.filter((pair) => !isDirectoryPair(pair));
    u.items.splice(index === -1 ? 1 : index, 0, ...templatePairs);
    if (serialiseDirectoryPairs(u) !== before) {
      fixes.push(`set directories on \`${eco}\` to match the template`);
    }
  }
  return { fixes, merges };
}

/**
 * Append template entries for `detected` ecosystems `updates` lacks.
 *
 * @param updates The `updates` list. Mutated.
 * @returns The ecosystems added.
 */
function addMissingEcosystems(
  updates: YAMLSeq,
  template: DependabotTemplate,
  detected: Set<string>,
): Array<string> {
  const existingEcos = new Set(updates.items.map(readEcosystem));
  const added: Array<string> = [];
  for (const eco of detected) {
    const templateEntry = template.entryByEcosystem.get(eco);
    if (!existingEcos.has(eco) && templateEntry) {
      // Clone so we don’t share nodes with the template doc; the clone
      // keeps the comments attached to the template entry. Strip its
      // scalar quoting so the spliced block matches the host doc’s
      // style instead of the template’s.
      const cloned = templateEntry.clone() as YAMLMap;
      clearScalarQuoting(cloned);
      updates.add(cloned);
      added.push(eco);
    }
  }
  return added;
}

/**
 * Add missing ecosystems from the template, set a missing `version`,
 * enforce a cooldown on every entry and make entries cover manifests
 * in subdirectories. Returns null when the file is fine, unparseable,
 * or has an `updates` that is not a list.
 */
function updateExisting(
  existing: FileContent,
  template: DependabotTemplate,
  detected: Set<string>,
  manifestDirsByEcosystem: Map<string, Set<string>>,
  defaultBranch: string,
  log: Logger,
): Change | null {
  const parsed = parseExisting(existing, log);
  if (!parsed) {
    return null;
  }

  const fixes: Array<string> = [];
  if (parsed.get('version') == null) {
    parsed.set('version', 2);
    fixes.push('set `version: 2`');
  }
  let updates = parsed.get('updates');
  if (updates == null) {
    updates = parsed.createNode([]);
    parsed.set('updates', updates);
  }
  if (!yaml.isSeq(updates)) {
    log.warning('existing dependabot file has a non-list `updates`, skipping');
    return null;
  }

  // Directories first, so merged-away entries don’t get other fixes.
  const directories = ensureTemplateDirectories(
    updates,
    template,
    manifestDirsByEcosystem,
    defaultBranch,
  );
  fixes.push(...ensureCooldowns(parsed, updates), ...directories.fixes);
  const added = addMissingEcosystems(updates, template, detected);
  if (
    fixes.length === 0 &&
    added.length === 0 &&
    directories.merges.length === 0
  ) {
    return null;
  }

  const parts: Array<string> = [];
  if (added.length > 0) {
    parts.push(`added sections: ${added.map((e) => `\`${e}\``).join(', ')}`);
  }
  parts.push(...fixes);
  return {
    path: existing.path,
    sha: existing.sha,
    newContent: stringifyDependabotDoc(parsed),
    summary:
      parts.length > 0
        ? `updated \`${existing.path}\`: ${parts.join('; ')}`
        : `updated \`${existing.path}\``,
    warnings: directories.merges.map((m) => `${m} in \`${existing.path}\``),
  };
}

interface PlanDependabotParams {
  detected: Set<string>;
  manifestDirsByEcosystem: Map<string, Set<string>>;
  existing: FileContent | null;
  template: DependabotTemplate;
  /** What entries without a `target-branch` update. */
  defaultBranch: string;
  log: Logger;
}

/**
 * The change to make to a repo’s dependabot config, or `null` when
 * nothing needs doing. `existing` is the current file as returned by
 * `tryGetContent`, or `null`. Problems that are not fatal go to `log`.
 */
export function planDependabotChange({
  detected,
  manifestDirsByEcosystem,
  existing,
  template,
  defaultBranch,
  log,
}: PlanDependabotParams): Change | null {
  if (detected.size === 0) {
    // No detected ecosystems — nothing to add.
    return null;
  }
  if (!existing) {
    return createFromTemplate(template, detected);
  }
  return updateExisting(
    existing,
    template,
    detected,
    manifestDirsByEcosystem,
    defaultBranch,
    log,
  );
}
