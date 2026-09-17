import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { runChecks } from './run-checks.ts'
import { fakeLog, fakeSnapshot } from './fixtures.ts'
import type { Check, FileFix } from './types.ts'

const fileFix = (path: string, content: string): FileFix => ({
  kind: 'file',
  path,
  content,
  lang: '',
  describe: `write ${path}`,
})

const check = (name: string, run: Check['run'], opensPr = true): Check => ({
  name,
  opensPr,
  run,
})

describe('runChecks', () => {
  it('stamps the repo and lets later checks read earlier fixes', async () => {
    const snapshot = await fakeSnapshot({ files: { 'a.txt': 'one\n' } })
    const seen: Array<string | undefined> = []
    const findings = await runChecks(
      [
        check('first', async (s) => {
          const file = await s.readFile('a.txt')
          return [
            {
              level: 'info',
              summary: 'extend a',
              fix: fileFix('a.txt', `${file?.content}two\n`),
            },
          ]
        }),
        check('second', async (s) => {
          seen.push((await s.readFile('a.txt'))?.content)
          return []
        }),
      ],
      snapshot
    )
    assert.deepEqual(seen, ['one\ntwo\n'])
    assert.equal(findings.length, 1)
    assert.equal(findings[0].repo, 'org/r')
    assert.equal(findings[0].outcome, undefined)
    assert.equal(snapshot.workingCopy.pending.get('a.txt'), 'one\ntwo\n')
  })

  it('turns a throwing check into an error finding and keeps going', async () => {
    const log = fakeLog()
    const snapshot = await fakeSnapshot({ log })
    const findings = await runChecks(
      [
        check('broken', async () => {
          throw new Error('kaboom')
        }),
        check('fine', async () => [{ level: 'info', summary: 'ok' }]),
      ],
      snapshot
    )
    assert.deepEqual(findings, [
      {
        repo: 'org/r',
        level: 'error',
        summary: 'broken check failed',
        details: ['kaboom'],
      },
      { repo: 'org/r', level: 'info', summary: 'ok' },
    ])
    assert.deepEqual(log.calls.error, ['broken check failed: kaboom'])
  })

  it('fails a blind overwrite of a pending fix', async () => {
    const snapshot = await fakeSnapshot()
    const findings = await runChecks(
      [
        check('first', async () => [
          { level: 'info', summary: 'a', fix: fileFix('x', '1') },
        ]),
        check('blind', async () => [
          { level: 'info', summary: 'b', fix: fileFix('x', '2') },
        ]),
      ],
      snapshot
    )
    assert.equal(findings[0].outcome, undefined)
    assert.deepEqual(findings[1].outcome, {
      status: 'failed',
      detail: 'blind check changed x without reading the pending fix for it',
    })
    assert.equal(snapshot.workingCopy.pending.get('x'), '1')
  })

  it('accepts a fix from a check that read the path, even when it was missing', async () => {
    const snapshot = await fakeSnapshot()
    const findings = await runChecks(
      [
        check('creator', async (s) => {
          await s.readFile('x')
          return [{ level: 'info', summary: 'a', fix: fileFix('x', '1') }]
        }),
        check('extender', async (s) => {
          const file = await s.readFile('x')
          return [
            {
              level: 'info',
              summary: 'b',
              fix: fileFix('x', `${file?.content}2`),
            },
          ]
        }),
      ],
      snapshot
    )
    assert.equal(findings[1].outcome, undefined)
    assert.equal(snapshot.workingCopy.pending.get('x'), '12')
  })

  it('fails a second fix for the same path from one check', async () => {
    const snapshot = await fakeSnapshot()
    const findings = await runChecks(
      [
        check('twice', async () => [
          { level: 'info', summary: 'a', fix: fileFix('x', '1') },
          { level: 'info', summary: 'b', fix: fileFix('x', '2') },
        ]),
      ],
      snapshot
    )
    assert.equal(findings[0].outcome, undefined)
    assert.equal(findings[1].outcome?.status, 'failed')
    assert.equal(snapshot.workingCopy.pending.get('x'), '1')
  })

  it('makes created files visible in listPaths', async () => {
    const snapshot = await fakeSnapshot({ paths: ['README.md'] })
    await runChecks(
      [
        check('creator', async () => [
          {
            level: 'info',
            summary: 'a',
            fix: fileFix('.github/dependabot.yaml', 'version: 2\n'),
          },
        ]),
      ],
      snapshot
    )
    assert.deepEqual(await snapshot.listPaths(), [
      '/README.md',
      '/.github/dependabot.yaml',
    ])
  })
})
