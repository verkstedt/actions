import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { auditRepo } from './audit-repo.mjs'
import { parseDependabotTemplate } from './dependabot-config.mjs'
import {
  fakeOctokit,
  fileResponse,
  httpError,
  fakeLog,
  DEPENDABOT_TEMPLATE,
} from './fixtures.mjs'

const repoMeta = { name: 'r', default_branch: 'main' }

/**
 * A repo with the given tree paths and files (path → content), no open
 * PRs and one human contributor, unless overridden.
 */
function fakeRepo({ paths = [], files = {}, openPrs = [], contributors } = {}) {
  return fakeOctokit({
    'pulls.list': () => openPrs,
    'git.getRef': () => ({ object: { sha: 'head' } }),
    'git.getCommit': () => ({ tree: { sha: 'tree' } }),
    'git.getTree': () => ({
      truncated: false,
      tree: paths.map((p) => ({ path: p })),
    }),
    'repos.getContent': ({ path }) => {
      if (path in files) return fileResponse(path, files[path])
      throw httpError(404)
    },
    'repos.listContributors': () =>
      contributors ?? [{ type: 'User', login: 'alice' }],
    'git.createRef': () => ({}),
    'repos.createOrUpdateFileContents': () => ({}),
    'pulls.create': ({ body, head }) => ({
      number: 42,
      html_url: 'https://p/42',
      head: { sha: 'prhead', ref: head },
      body,
    }),
    'pulls.requestReviewers': () => ({}),
    'pulls.createReview': () => ({}),
  })
}

const callsTo = (octokit, name) =>
  octokit.calls.filter((c) => c.name === name).map((c) => c.params)

describe('auditRepo', () => {
  const template = parseDependabotTemplate(DEPENDABOT_TEMPLATE)
  const ctx = (octokit, dryRun = false) => ({
    octokit,
    org: 'org',
    dryRun,
    template,
    runId: 123,
    runAttempt: 2,
    log: fakeLog(),
  })

  it('skips a repo that already has a hygiene PR open', async () => {
    const octokit = fakeRepo({
      openPrs: [
        {
          html_url: 'https://p/1',
          head: { ref: 'chore/repo-hygiene/99', repo: { full_name: 'Org/R' } },
          requested_reviewers: [{ login: 'alice' }],
          requested_teams: [{ slug: 'devs' }],
        },
        {
          html_url: 'https://p/2',
          head: { ref: 'feature', repo: { full_name: 'org/r' } },
        },
      ],
    })
    const { results } = await auditRepo(ctx(octokit), repoMeta)
    assert.deepEqual(results, [
      {
        repo: 'org/r',
        action: 'skipped-existing-pr',
        prUrl: 'https://p/1',
        reviewers: ['@alice', '@org/devs'],
      },
    ])
    assert.equal(callsTo(octokit, 'git.getRef').length, 0)
  })

  it('reports ok when dependabot config and CODEOWNERS are complete', async () => {
    const octokit = fakeRepo({
      paths: ['package.json', 'package-lock.json'],
      files: {
        '.github/dependabot.yaml': DEPENDABOT_TEMPLATE,
        CODEOWNERS: 'package-lock.json @alice\n',
      },
    })
    const { results } = await auditRepo(ctx(octokit), repoMeta)
    assert.deepEqual(results, [{ repo: 'org/r', action: 'ok' }])
    assert.equal(callsTo(octokit, 'pulls.create').length, 0)
  })

  it('reports ok for a repo with nothing to configure', async () => {
    const octokit = fakeRepo({ paths: ['README.md'] })
    const { results } = await auditRepo(ctx(octokit), repoMeta)
    assert.deepEqual(results, [{ repo: 'org/r', action: 'ok' }])
  })

  it('opens a PR adding both files, with contributors as reviewers', async () => {
    const octokit = fakeRepo({
      paths: ['package.json', 'package-lock.json', '.github/workflows/ci.yaml'],
    })
    const { results } = await auditRepo(ctx(octokit), repoMeta)
    assert.deepEqual(results, [
      {
        repo: 'org/r',
        action: 'opened-pr',
        prUrl: 'https://p/42',
        reviewers: ['@alice'],
      },
    ])

    assert.deepEqual(callsTo(octokit, 'git.createRef'), [
      {
        owner: 'org',
        repo: 'r',
        ref: 'refs/heads/chore/repo-hygiene/123-2',
        sha: 'head',
      },
    ])

    const commits = callsTo(octokit, 'repos.createOrUpdateFileContents')
    assert.deepEqual(
      commits.map((c) => [c.path, c.message, c.branch]),
      [
        [
          '.github/dependabot.yaml',
          'chore: Add .github/dependabot.yaml',
          'chore/repo-hygiene/123-2',
        ],
        ['CODEOWNERS', 'chore: Add CODEOWNERS', 'chore/repo-hygiene/123-2'],
      ]
    )
    const codeowners = Buffer.from(commits[1].content, 'base64').toString()
    assert.equal(
      codeowners,
      [
        '# Make sure dependabot PRs get reviewers assigned',
        'package-lock.json  @OWNER',
        '/.github/workflows/  @OWNER',
        '',
      ].join('\n')
    )

    const [pr] = callsTo(octokit, 'pulls.create')
    assert.equal(pr.title, 'chore: Repo hygiene')
    assert.equal(pr.base, 'main')
    assert.equal(pr.head, 'chore/repo-hygiene/123-2')
    assert.match(pr.body, /Assigned repo contributors as reviewers/)
    assert.match(
      pr.body,
      /## What\?\n\n- created `\.github\/dependabot\.yaml` with sections: `npm`, `github-actions`\n- created `CODEOWNERS` with 2 line\(s\)/
    )

    assert.deepEqual(callsTo(octokit, 'pulls.requestReviewers'), [
      { owner: 'org', repo: 'r', pull_number: 42, reviewers: ['alice'] },
    ])

    // @OWNER placeholder → one review comment spanning the added lines.
    const [review] = callsTo(octokit, 'pulls.createReview')
    assert.equal(review.commit_id, 'prhead')
    assert.deepEqual(review.comments[0].start_line, 2)
    assert.deepEqual(review.comments[0].line, 3)
  })

  it('reuses matching code owners and skips the placeholder comment', async () => {
    const octokit = fakeRepo({
      paths: ['package.json', 'package-lock.json', 'Dockerfile'],
      files: {
        '.github/dependabot.yaml': DEPENDABOT_TEMPLATE,
        '.github/CODEOWNERS': 'package-lock.json @bob @org/devs\n',
      },
    })
    const { results } = await auditRepo(ctx(octokit), repoMeta)
    assert.equal(results[0].action, 'opened-pr')
    assert.deepEqual(results[0].reviewers, ['@bob', '@org/devs'])

    const commits = callsTo(octokit, 'repos.createOrUpdateFileContents')
    assert.deepEqual(
      commits.map((c) => c.path),
      ['.github/CODEOWNERS']
    )
    assert.equal(commits[0].message, 'chore: Update .github/CODEOWNERS')
    assert.equal(
      Buffer.from(commits[0].content, 'base64').toString(),
      'package-lock.json @bob @org/devs\nDockerfile  @bob @org/devs\n'
    )
    assert.equal(callsTo(octokit, 'pulls.createReview').length, 0)
    assert.equal(callsTo(octokit, 'repos.listContributors').length, 0)
    const [pr] = callsTo(octokit, 'pulls.create')
    assert.doesNotMatch(pr.body, /Assigned/)
  })

  it('adds an owner when the covering CODEOWNERS line has none', async () => {
    const octokit = fakeRepo({
      paths: ['package.json', 'package-lock.json'],
      files: {
        '.github/dependabot.yaml': DEPENDABOT_TEMPLATE,
        '.github/CODEOWNERS': '/docs/ @writer\npackage-lock.json\n',
      },
    })
    const { results } = await auditRepo(ctx(octokit), repoMeta)
    assert.equal(results[0].action, 'opened-pr')
    assert.deepEqual(results[0].reviewers, ['@writer'])

    const commits = callsTo(octokit, 'repos.createOrUpdateFileContents')
    assert.deepEqual(
      commits.map((c) => c.path),
      ['.github/CODEOWNERS']
    )
    assert.equal(
      Buffer.from(commits[0].content, 'base64').toString(),
      '/docs/ @writer\npackage-lock.json\npackage-lock.json  @OWNER\n'
    )
  })

  it('only renders the summary in a dry run', async () => {
    const octokit = fakeRepo({
      paths: ['package.json', 'yarn.lock'],
      contributors: [],
    })
    const { results, summary } = await auditRepo(ctx(octokit, true), repoMeta)
    assert.deepEqual(results, [
      {
        repo: 'org/r',
        action: 'dry-run',
        reviewers: [],
        unresolvedOwner: true,
      },
    ])
    assert.equal(callsTo(octokit, 'git.createRef').length, 0)
    assert.equal(callsTo(octokit, 'pulls.create').length, 0)

    assert.match(summary, /^### org\/r\n/)
    assert.match(summary, /#### Reviewers\n\n\(none\)/)
    assert.match(summary, /Could not determine who to assign as reviewers/)
    assert.match(
      summary,
      /\*\*\.github\/dependabot\.yaml\*\* \(create\):\n\n```yaml\n/
    )
    assert.match(
      summary,
      /\*\*CODEOWNERS\*\* \(create\):\n\n```\n# Make sure dependabot PRs get reviewers assigned\nyarn\.lock {2}@OWNER\n\n```/
    )
  })

  it('reports no unresolved owner when CODEOWNERS needs no change', async () => {
    const octokit = fakeRepo({
      paths: ['package.json', 'package-lock.json'],
      files: { '.github/CODEOWNERS': 'package-lock.json @bob\n' },
    })
    const { results, summary } = await auditRepo(ctx(octokit, true), repoMeta)
    assert.match(summary, /^### org\/r\n/)
    assert.deepEqual(results, [
      {
        repo: 'org/r',
        action: 'dry-run',
        reviewers: ['@bob'],
        unresolvedOwner: false,
      },
    ])
  })
})
