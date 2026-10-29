/**
 * Keeps workflows created from the org-wide CI template in
 * `verkstedt/.github` up to date.
 *
 * A workflow in `.github/workflows/` that, ignoring comments,
 * formatting and key order, equals an earlier version of the template
 * is replaced with the current one. That alone does not open a PR: the
 * update is only applied alongside other fixes.
 */

import yaml from 'yaml';

import { tryGetContent } from '../github.ts';
import { TEMPLATE_REPO } from '../templates.ts';
import type { Check, CheckFinding, Octokit } from '../types.ts';

const TEMPLATE_PATH = 'workflow-templates/ci.yaml';
/** Matches tree paths, which start with `/`. */
const WORKFLOW_RE = /^\/(\.github\/workflows\/[^/]+\.ya?ml)$/;

interface CiTemplate {
  content: string;
  /** Canonical forms of earlier versions that differ from `content`. */
  outdated: Set<string>;
}

let template: CiTemplate | null = null;

function requireLoadedTemplate(): CiTemplate {
  if (!template) {
    throw new Error('ci-workflow check used before setup');
  }
  return template;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/**
 * The YAML’s data as a string, so comments, formatting and key order
 * do not matter; `null` when it does not parse.
 */
export function canonicaliseYaml(content: string): string | null {
  try {
    return JSON.stringify(sortKeys(yaml.parse(content)));
  } catch {
    return null;
  }
}

/** The last 20 versions of the template, newest first, from its commit history. */
async function loadCiTemplate(octokit: Octokit): Promise<CiTemplate> {
  const { data: commits } = await octokit.rest.repos.listCommits({
    ...TEMPLATE_REPO,
    path: TEMPLATE_PATH,
    per_page: 20,
  });
  const files = await Promise.all(
    commits.map(({ sha }) =>
      tryGetContent(octokit, {
        ...TEMPLATE_REPO,
        paths: [TEMPLATE_PATH],
        ref: sha,
      }),
    ),
  );
  const versions = files.flatMap((file) => (file ? [file.content] : []));
  if (versions.length === 0) {
    throw new Error(`verkstedt/.github has no ${TEMPLATE_PATH}`);
  }
  const [content, ...earlier] = versions;
  const current = canonicaliseYaml(content);
  const outdated = new Set(
    earlier
      .map(canonicaliseYaml)
      .filter((c): c is string => c !== null && c !== current),
  );
  return { content, outdated };
}

/**
 * Workflows that equal an earlier version of the org-wide CI template
 * get the current one, but only alongside other fixes.
 */
export const ciWorkflow: Check = {
  name: 'ci-workflow',
  opensPr: true,
  setup: async (octokit) => {
    template = await loadCiTemplate(octokit);
  },
  run: async (snapshot) => {
    const { content, outdated } = requireLoadedTemplate();
    const paths = (await snapshot.listPaths()).flatMap(
      (p) => WORKFLOW_RE.exec(p)?.[1] ?? [],
    );
    const files = await Promise.all(paths.map((p) => snapshot.readFile(p)));
    return paths.flatMap((path, i): Array<CheckFinding> => {
      const file = files[i];
      const canonical = file && canonicaliseYaml(file.content);
      if (!canonical || !outdated.has(canonical)) {
        return [];
      }
      return [
        {
          level: 'info',
          summary: `\`${path}\` is based on an outdated CI template`,
          fix: {
            kind: 'file',
            path,
            content,
            lang: 'yaml',
            describe: `updated \`${path}\` to the latest [CI template](https://github.com/verkstedt/.github/blob/HEAD/${TEMPLATE_PATH})`,
            onlyWithOthers: true,
          },
        },
      ];
    });
  },
};
