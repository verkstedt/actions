import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createFileResponse,
  createHttpError,
  fakeOctokit,
} from '../__fixtures__/octokit.ts';
import { fakeSnapshot } from '../__fixtures__/repo.ts';

import { canonicaliseYaml, ciWorkflow } from './ci-workflow.ts';

const CURRENT = `# Current
name: 'CI'
on:
  push:
    branches: [main]
jobs:
  ci:
    uses: verkstedt/actions/.github/workflows/ci.yaml@v1
`;
const COMMENT_ONLY = `# Older comment\n${CURRENT}`;
const OLD = `# Old
name: 'CI'
on: push
jobs:
  ci:
    uses: verkstedt/actions/.github/workflows/ci.yaml@v1
`;

/** Template history, newest first, as sha → content. */
const templateOctokit = (history: Record<string, string>) =>
  fakeOctokit({
    'repos.listCommits': () => Object.keys(history).map((sha) => ({ sha })),
    'repos.getContent': ({ path, ref }: { path: string; ref: string }) => {
      if (ref in history) {
        return createFileResponse(path, history[ref]);
      }
      throw createHttpError(404);
    },
  });

const { setup } = ciWorkflow;
assert.ok(setup);

describe('canonicaliseYaml', () => {
  it('ignores comments, formatting and key order', () => {
    assert.equal(
      canonicaliseYaml("# hi\na: 1\nb: [x, 'y']\n"),
      canonicaliseYaml('b:\n  - "x"\n  - y\na:   1 # there\n'),
    );
  });

  it('keeps indentation that changes the data', () => {
    assert.notEqual(
      canonicaliseYaml('a:\n  b: 1\nc: 2\n'),
      canonicaliseYaml('a:\n  b: 1\n  c: 2\n'),
    );
  });

  it('returns null for invalid YAML', () => {
    assert.equal(canonicaliseYaml('a: [\n'), null);
  });
});

describe('ciWorkflow', () => {
  it('fails setup when the template has no history', async () => {
    await assert.rejects(setup(templateOctokit({})), {
      message: 'verkstedt/.github has no workflow-templates/ci.yaml',
    });
  });

  it('replaces a workflow equal to an old version, only alongside others', async () => {
    await setup(templateOctokit({ c3: CURRENT, c2: COMMENT_ONLY, c1: OLD }));
    const snapshot = await fakeSnapshot({
      paths: ['.github/workflows/ci.yml', '.github/workflows/other.yaml'],
      files: {
        '.github/workflows/ci.yml': OLD.replace('# Old', '# Mine'),
        '.github/workflows/other.yaml': 'name: other\n',
      },
    });
    const findings = await ciWorkflow.run(snapshot);
    assert.equal(findings.length, 1);
    const [finding] = findings;
    assert.equal(
      finding.summary,
      '`.github/workflows/ci.yml` is based on an outdated CI template',
    );
    assert.equal(finding.fix?.kind, 'file');
    assert.equal(finding.fix.path, '.github/workflows/ci.yml');
    assert.equal(finding.fix.content, CURRENT);
    assert.equal(finding.fix.onlyWithOthers, true);
  });

  it('leaves current and modified workflows alone', async () => {
    await setup(templateOctokit({ c3: CURRENT, c2: COMMENT_ONLY, c1: OLD }));
    const snapshot = await fakeSnapshot({
      paths: ['.github/workflows/a.yaml', '.github/workflows/b.yaml'],
      files: {
        '.github/workflows/a.yaml': COMMENT_ONLY,
        '.github/workflows/b.yaml': `${OLD}  extra:\n    runs-on: x\n`,
      },
    });
    assert.deepEqual(await ciWorkflow.run(snapshot), []);
  });
});
