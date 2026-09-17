import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { takeSnapshot } from './snapshot.ts'
import { callsTo, fakeLog, fakeRepo, httpError } from './fixtures.ts'

const repoMeta = { name: 'r', default_branch: 'main' }
const take = (octokit: ReturnType<typeof fakeRepo>) =>
  takeSnapshot(octokit, repoMeta, { org: 'org', log: fakeLog() })

describe('takeSnapshot', () => {
  it('fetches only the head SHA up front', async () => {
    const octokit = fakeRepo({ paths: ['package.json'] })
    const snapshot = await take(octokit)
    assert.equal(snapshot.headSha, 'head')
    assert.deepEqual(callsTo(octokit, 'git.getRef'), [
      { owner: 'org', repo: 'r', ref: 'heads/main' },
    ])
    assert.equal(callsTo(octokit, 'git.getTree').length, 0)
    assert.equal(callsTo(octokit, 'pulls.list').length, 0)
  })

  it('lists paths once, prefixed with a slash, and warns on truncation', async () => {
    const log = fakeLog()
    const octokit = fakeRepo({
      paths: ['package.json', '.github/workflows/ci.yaml'],
      handlers: {
        'git.getTree': () => ({
          truncated: true,
          tree: [{ path: 'package.json' }],
        }),
      },
    })
    const snapshot = await takeSnapshot(octokit, repoMeta, { org: 'org', log })
    assert.deepEqual(await snapshot.listPaths(), ['/package.json'])
    await snapshot.listPaths()
    assert.equal(callsTo(octokit, 'git.getTree').length, 1)
    assert.deepEqual(callsTo(octokit, 'git.getCommit'), [
      { owner: 'org', repo: 'r', commit_sha: 'head' },
    ])
    assert.deepEqual(log.calls.warning, [
      'tree response truncated; detection may be incomplete',
    ])
  })

  it('reads files pinned to the head SHA and memoises them', async () => {
    const octokit = fakeRepo({ files: { CODEOWNERS: 'a @x\n' } })
    const snapshot = await take(octokit)
    assert.deepEqual(await snapshot.readFile('CODEOWNERS'), {
      path: 'CODEOWNERS',
      sha: 'sha-CODEOWNERS',
      content: 'a @x\n',
    })
    assert.equal(await snapshot.readFile('missing'), null)
    await snapshot.readFile('CODEOWNERS')
    await snapshot.readFileOnDefaultBranch('CODEOWNERS')
    const reads = callsTo(octokit, 'repos.getContent')
    assert.deepEqual(
      reads.map((p) => [p.path, p.ref]),
      [
        ['CODEOWNERS', 'head'],
        ['missing', 'head'],
      ]
    )
  })

  it('returns the first existing candidate', async () => {
    const snapshot = await take(fakeRepo({ files: { CODEOWNERS: 'x' } }))
    const file = await snapshot.readFirstFile([
      '.github/CODEOWNERS',
      'CODEOWNERS',
      'docs/CODEOWNERS',
    ])
    assert.equal(file?.path, 'CODEOWNERS')
    assert.equal(
      await snapshot.readFirstFile(['.github/CODEOWNERS', 'docs/CODEOWNERS']),
      null
    )
  })

  it('serves the working copy from readFile but not from readFileOnDefaultBranch', async () => {
    const snapshot = await take(fakeRepo({ files: { CODEOWNERS: 'old\n' } }))
    snapshot.workingCopy.attach('CODEOWNERS', 'new\n')
    assert.deepEqual(await snapshot.readFile('CODEOWNERS'), {
      path: 'CODEOWNERS',
      sha: 'sha-CODEOWNERS',
      content: 'new\n',
    })
    assert.equal(
      (await snapshot.readFileOnDefaultBranch('CODEOWNERS'))?.content,
      'old\n'
    )
  })

  it('has no sha for a working copy of a file that does not exist yet', async () => {
    const snapshot = await take(fakeRepo())
    snapshot.workingCopy.attach('.github/dependabot.yaml', 'version: 2\n')
    assert.deepEqual(await snapshot.readFile('.github/dependabot.yaml'), {
      path: '.github/dependabot.yaml',
      sha: undefined,
      content: 'version: 2\n',
    })
    assert.deepEqual(await snapshot.listPaths(), ['/.github/dependabot.yaml'])
  })

  it('records which paths a check read, including misses', async () => {
    const snapshot = await take(fakeRepo({ files: { a: '1' } }))
    await snapshot.readFile('a')
    await snapshot.readFirstFile(['b', 'c'])
    await snapshot.readFileOnDefaultBranch('d')
    assert.deepEqual([...snapshot.workingCopy.reads], ['a', 'b', 'c'])
    snapshot.workingCopy.startCheck()
    assert.equal(snapshot.workingCopy.reads.size, 0)
  })

  it('lists open PRs once', async () => {
    const octokit = fakeRepo({ openPrs: [{ number: 1 }] })
    const snapshot = await take(octokit)
    assert.deepEqual(await snapshot.listOpenPrs(), [{ number: 1 }])
    await snapshot.listOpenPrs()
    assert.equal(callsTo(octokit, 'pulls.list').length, 1)
  })

  it('leaves checks that never list paths unaffected by a tree failure', async () => {
    const snapshot = await take(
      fakeRepo({
        files: { a: '1' },
        handlers: {
          'git.getTree': () => {
            throw httpError(500, 'tree down')
          },
        },
      })
    )
    assert.equal((await snapshot.readFile('a'))?.content, '1')
    await assert.rejects(snapshot.listPaths(), { message: 'tree down' })
  })
})
