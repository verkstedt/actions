import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  tryGetContent,
  fetchBranchTree,
  commitChange,
  createLineComment,
  assertAppSeesAllRepos,
  listTargetRepos,
} from './github.ts'
import { fakeOctokit, fileResponse, httpError, fakeLog } from './fixtures.ts'

describe('tryGetContent', () => {
  it('returns the first path that exists, decoded', async () => {
    const octokit = fakeOctokit({
      'repos.getContent': ({ path }) => {
        if (path === 'CODEOWNERS') return fileResponse(path, '* @a\n', 'sha1')
        throw httpError(404)
      },
    })
    const found = await tryGetContent(octokit, {
      owner: 'org',
      repo: 'r',
      ref: 'main',
      paths: ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'],
    })
    assert.deepEqual(found, {
      sha: 'sha1',
      path: 'CODEOWNERS',
      content: '* @a\n',
    })
    assert.deepEqual(
      octokit.calls.map((c) => c.params.path),
      ['.github/CODEOWNERS', 'CODEOWNERS']
    )
    assert.equal(octokit.calls[0].params.ref, 'main')
  })

  it('returns null when every path is missing', async () => {
    const octokit = fakeOctokit({
      'repos.getContent': () => {
        throw httpError(404)
      },
    })
    assert.equal(
      await tryGetContent(octokit, {
        owner: 'org',
        repo: 'r',
        paths: ['a', 'b'],
      }),
      null
    )
  })

  it('skips directories', async () => {
    const octokit = fakeOctokit({ 'repos.getContent': () => [] })
    assert.equal(
      await tryGetContent(octokit, {
        owner: 'org',
        repo: 'r',
        paths: ['docs'],
      }),
      null
    )
  })

  it('rethrows other errors', async () => {
    const octokit = fakeOctokit({
      'repos.getContent': () => {
        throw httpError(500)
      },
    })
    await assert.rejects(
      tryGetContent(octokit, { owner: 'org', repo: 'r', paths: ['a'] }),
      {
        status: 500,
      }
    )
  })
})

describe('fetchBranchTree', () => {
  it('walks ref → commit → tree and prefixes paths with /', async () => {
    const octokit = fakeOctokit({
      'git.getRef': () => ({ object: { sha: 'head' } }),
      'git.getCommit': () => ({ tree: { sha: 'tree' } }),
      'git.getTree': () => ({
        truncated: false,
        tree: [{ path: 'package.json' }, { path: '.github/workflows/ci.yaml' }],
      }),
    })
    const result = await fetchBranchTree(octokit, {
      org: 'org',
      repo: 'r',
      branch: 'main',
      log: fakeLog(),
    })
    assert.deepEqual(result, {
      headSha: 'head',
      paths: ['/package.json', '/.github/workflows/ci.yaml'],
    })
    assert.equal(octokit.calls[0].params.ref, 'heads/main')
    assert.equal(octokit.calls[1].params.commit_sha, 'head')
    assert.deepEqual(octokit.calls[2].params, {
      owner: 'org',
      repo: 'r',
      tree_sha: 'tree',
      recursive: '1',
    })
  })
})

describe('commitChange', () => {
  it('adds a new file', async () => {
    const octokit = fakeOctokit({
      'repos.createOrUpdateFileContents': () => ({}),
    })
    await commitChange(octokit, {
      org: 'org',
      repo: 'r',
      branch: 'b',
      path: 'CODEOWNERS',
      content: 'x @a\n',
    })
    const { params } = octokit.calls[0]
    assert.equal(params.message, 'chore: Add CODEOWNERS')
    assert.equal(params.sha, undefined)
    assert.equal(Buffer.from(params.content, 'base64').toString(), 'x @a\n')
    assert.equal(params.branch, 'b')
  })

  it('updates an existing file when the change carries a sha', async () => {
    const octokit = fakeOctokit({
      'repos.createOrUpdateFileContents': () => ({}),
    })
    await commitChange(octokit, {
      org: 'org',
      repo: 'r',
      branch: 'b',
      path: '.github/dependabot.yaml',
      content: '',
      sha: 'old',
    })
    const { params } = octokit.calls[0]
    assert.equal(params.message, 'chore: Update .github/dependabot.yaml')
    assert.equal(params.sha, 'old')
  })
})

describe('createLineComment', () => {
  const pr = { number: 7, head: { sha: 'prhead' } }

  it('comments on a single line', async () => {
    const octokit = fakeOctokit({ 'pulls.createReview': () => ({}) })
    await createLineComment(octokit, {
      org: 'org',
      repo: 'r',
      pr,
      path: 'CODEOWNERS',
      lineNumbers: [4],
      body: 'fix me',
    })
    const { params } = octokit.calls[0]
    assert.equal(params.pull_number, 7)
    assert.equal(params.commit_id, 'prhead')
    assert.equal(params.event, 'COMMENT')
    assert.deepEqual(params.comments, [
      { path: 'CODEOWNERS', body: 'fix me', side: 'RIGHT', line: 4 },
    ])
  })

  it('spans a range of lines', async () => {
    const octokit = fakeOctokit({ 'pulls.createReview': () => ({}) })
    await createLineComment(octokit, {
      org: 'org',
      repo: 'r',
      pr,
      path: 'CODEOWNERS',
      lineNumbers: [6, 4, 5],
      body: 'fix me',
    })
    const [comment] = octokit.calls[0].params.comments
    assert.equal(comment.start_line, 4)
    assert.equal(comment.start_side, 'RIGHT')
    assert.equal(comment.line, 6)
  })

  it('throws when the review cannot be created', async () => {
    const octokit = fakeOctokit({
      'pulls.createReview': () => {
        throw httpError(422, 'Unprocessable')
      },
    })
    await assert.rejects(
      createLineComment(octokit, {
        org: 'org',
        repo: 'r',
        pr: { number: 1, head: { sha: 's' } },
        path: 'CODEOWNERS',
        lineNumbers: [2, 3],
        body: 'x',
      }),
      { message: 'Unprocessable' }
    )
  })
})

describe('assertAppSeesAllRepos', () => {
  it('passes for an App installed on all repos', async () => {
    const octokit = fakeOctokit({
      'GET /installation/repositories': () => ({ repository_selection: 'all' }),
    })
    await assertAppSeesAllRepos(octokit)
  })

  it('throws otherwise', async () => {
    const octokit = fakeOctokit({
      'GET /installation/repositories': () => ({
        repository_selection: 'selected',
      }),
    })
    await assert.rejects(assertAppSeesAllRepos(octokit), {
      message: /repository_selection='selected'/,
    })
  })
})

describe('listTargetRepos', () => {
  const repos = [
    { name: 'a', default_branch: 'main', size: 1 },
    { name: 'b-old', default_branch: 'main', size: 1, archived: true },
    { name: 'b-new', default_branch: 'main', size: 1 },
    { name: 'empty', default_branch: 'main', size: 0 },
  ]
  const octokit = () => fakeOctokit({ 'repos.listForOrg': () => repos })

  it('skips archived, disabled and empty repos', async () => {
    const targets = await listTargetRepos(octokit(), {
      org: 'org',
      reposFilter: [],
    })
    assert.deepEqual(
      targets.map((r) => r.name),
      ['a', 'b-new']
    )
  })

  it('narrows by glob and throws when a pattern matches nothing', async () => {
    const targets = await listTargetRepos(octokit(), {
      org: 'org',
      reposFilter: ['b-*'],
    })
    assert.deepEqual(
      targets.map((r) => r.name),
      ['b-new']
    )
    await assert.rejects(
      listTargetRepos(octokit(), { org: 'org', reposFilter: ['a', 'zzz'] }),
      { message: /"zzz" matched no repos/ }
    )
  })
})
