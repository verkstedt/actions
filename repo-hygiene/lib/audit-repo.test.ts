import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fakeLog } from './__fixtures__/log.ts';
import { createHttpError, listCallsTo } from './__fixtures__/octokit.ts';
import { fakeRepo } from './__fixtures__/repo.ts';
import { auditRepo } from './audit-repo.ts';
import type { Check } from './types.ts';

const repoMeta = { name: 'r', default_branch: 'main' };
const options = (checks: Array<Check>) => ({
  org: 'org',
  checks,
  dryRun: false,
  runId: 1,
  runAttempt: 1,
  log: fakeLog(),
});
const hygienePr = (url: string, fullName: string, userType = 'Bot') => ({
  number: 9,
  html_url: url,
  user: { login: 'hygiene[bot]', type: userType },
  head: {
    ref: 'chore/repo-hygiene/99-1',
    sha: 's',
    repo: { full_name: fullName },
  },
  requested_reviewers: [{ login: 'alice' }],
  requested_teams: [{ slug: 'devs' }],
});

describe('auditRepo', () => {
  it('skips PR-opening checks when a hygiene PR is open, one finding per PR', async () => {
    const ran: Array<string> = [];
    const checks: Array<Check> = [
      {
        name: 'plain',
        run: async () => {
          ran.push('plain');
          return [];
        },
      },
      {
        name: 'pr',
        opensPr: true,
        run: async () => {
          ran.push('pr');
          return [];
        },
      },
    ];
    const octokit = fakeRepo({
      openPrs: [
        hygienePr('https://p/1', 'Org/R'),
        hygienePr('https://p/2', 'org/r'),
        hygienePr('https://p/3', 'someone/r'),
        hygienePr('https://p/4', 'org/r', 'User'),
      ],
    });
    const { findings } = await auditRepo(octokit, repoMeta, options(checks));
    assert.deepEqual(ran, ['plain']);
    assert.deepEqual(findings, [
      {
        repo: 'org/r',
        level: 'info',
        summary: 'hygiene PR already open',
        url: 'https://p/1',
        outcome: {
          status: 'skipped',
          url: 'https://p/1',
          detail: 'reviewers: @alice, @org/devs',
        },
      },
      {
        repo: 'org/r',
        level: 'info',
        summary: 'hygiene PR already open',
        url: 'https://p/2',
        outcome: {
          status: 'skipped',
          url: 'https://p/2',
          detail: 'reviewers: @alice, @org/devs',
        },
      },
    ]);
  });

  it('runs all checks and applies their fixes otherwise', async () => {
    const octokit = fakeRepo();
    const checks: Array<Check> = [
      {
        name: 'writer',
        opensPr: true,
        run: async () => [
          {
            level: 'info',
            summary: 'add x',
            fix: {
              kind: 'file',
              path: 'x',
              content: '1',
              lang: '',
              describe: 'added x',
            },
          },
        ],
      },
    ];
    const { findings, preview } = await auditRepo(
      octokit,
      repoMeta,
      options(checks),
    );
    assert.equal(findings[0].outcome?.status, 'fixed');
    assert.equal(findings[0].outcome.url, 'https://p/42');
    assert.equal(preview, null);
    assert.equal(listCallsTo(octokit, 'pulls.create').length, 1);
  });

  describe('findings resolved by a hygiene PR', () => {
    const resolvable: Check = {
      name: 'resolvable',
      run: async () => [
        {
          level: 'warning',
          summary: 'needs owners',
          resolvedByHygienePr: true,
        },
      ],
    };
    const writer = (onlyWithOthers = false): Check => ({
      name: 'writer',
      opensPr: true,
      run: async () => [
        {
          level: 'info',
          summary: 'add x',
          fix: {
            kind: 'file',
            path: 'x',
            content: '1',
            lang: '',
            describe: 'added x',
            onlyWithOthers,
          },
        },
      ],
    });
    const summaries = (findings: Array<{ summary: string }>) =>
      findings.map((f) => f.summary);

    it('are dropped when a hygiene PR is already open', async () => {
      const octokit = fakeRepo({
        openPrs: [hygienePr('https://p/1', 'org/r')],
      });
      const { findings } = await auditRepo(
        octokit,
        repoMeta,
        options([resolvable]),
      );
      assert.deepEqual(summaries(findings), ['hygiene PR already open']);
    });

    it('are dropped when this run opens a hygiene PR', async () => {
      const { findings } = await auditRepo(
        fakeRepo(),
        repoMeta,
        options([resolvable, writer()]),
      );
      assert.deepEqual(summaries(findings), ['add x']);
    });

    it('are kept when no hygiene PR is open or opened', async () => {
      const { findings } = await auditRepo(
        fakeRepo(),
        repoMeta,
        options([resolvable, writer(true)]),
      );
      assert.deepEqual(summaries(findings), ['needs owners', 'add x']);
    });
  });

  it('lets checks that do not list paths run when the tree cannot be fetched', async () => {
    const octokit = fakeRepo({
      handlers: {
        'git.getTree': () => {
          throw createHttpError(500, 'tree down');
        },
      },
    });
    const checks: Array<Check> = [
      {
        name: 'no tree',
        run: async () => [{ level: 'info', summary: 'fine' }],
      },
      {
        name: 'tree',
        opensPr: true,
        run: async (s) => {
          await s.listPaths();
          return [];
        },
      },
    ];
    const { findings } = await auditRepo(octokit, repoMeta, options(checks));
    assert.deepEqual(
      findings.map((f) => [f.level, f.summary]),
      [
        ['info', 'fine'],
        ['error', 'tree check failed'],
      ],
    );
  });

  it('throws when the head SHA cannot be fetched', async () => {
    const octokit = fakeRepo({
      handlers: {
        'git.getRef': () => {
          throw createHttpError(404, 'no branch');
        },
      },
    });
    await assert.rejects(auditRepo(octokit, repoMeta, options([])), {
      message: 'no branch',
    });
  });
});
