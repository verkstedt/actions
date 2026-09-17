import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { renderSlackText, report } from './report.ts'
import type { Result } from './types.ts'

const fillOrder = [
  { key: 'failed', partial: true },
  { key: 'opened', partial: true },
  { key: 'preexisting', partial: false },
] as const
const showOrder = ['failed', 'preexisting', 'opened'] as const
const runUrl = 'https://example.test/run/1'

const prItems = (prefix: string, count: number) =>
  Array.from(
    { length: count },
    (_, i) =>
      `<https://github.com/org/${prefix}-${i}/pull/1> — no reviewer assigned`
  )

describe('renderSlackText', () => {
  it('lists every non-empty section in show order, then the footer', () => {
    const text = renderSlackText({
      sections: {
        failed: { heading: '*Failed:*', items: ['a — boom'] },
        opened: { heading: '*Opened:*', items: ['<u> — reviewer(s): @x'] },
        preexisting: { heading: '*Old:*', items: [] },
      },
      fillOrder,
      showOrder,
      runUrl,
    })
    assert.equal(
      text,
      [
        '',
        '*Failed:*',
        '1. a — boom',
        '',
        '*Opened:*',
        '1. <u> — reviewer(s): @x',
        '',
        `<${runUrl}|Full list in the run summary>`,
      ].join('\n')
    )
  })

  it('stays within the Slack limit, truncating the less important lists', () => {
    const text = renderSlackText({
      sections: {
        failed: { heading: '*Failed:*', items: ['a — boom'] },
        opened: { heading: '*Opened:*', items: prItems('new', 200) },
        preexisting: { heading: '*Old:*', items: prItems('old', 50) },
      },
      fillOrder,
      showOrder,
      runUrl,
    })
    assert.ok(text.length <= 2600, `too long: ${text.length}`)
    assert.match(text, /1\. a — boom/)
    assert.match(text, /\*Opened:\*\n1\. </)
    assert.match(text, /… and \d+ more/)
    // Non-partial sections collapse to a count rather than list half.
    assert.match(text, /\*Old:\* 50 — see the run summary/)
    assert.doesNotMatch(text, /old-0/)
  })

  it('collapses a section to its count when even one item does not fit', () => {
    const text = renderSlackText({
      sections: {
        failed: { heading: '*Failed:*', items: [`x — ${'e'.repeat(2700)}`] },
        opened: { heading: '*Opened:*', items: [] },
        preexisting: { heading: '*Old:*', items: [] },
      },
      fillOrder,
      showOrder,
      runUrl,
    })
    assert.equal(
      text,
      [
        '',
        '*Failed:* 1 — see the run summary',
        '',
        `<${runUrl}|Full list in the run summary>`,
      ].join('\n')
    )
  })
})

describe('report', () => {
  const results: Array<Result> = [
    { repo: 'org/a', action: 'ok' },
    {
      repo: 'org/b',
      action: 'opened-pr',
      prUrl: 'https://p/b',
      reviewers: ['@x'],
    },
    {
      repo: 'org/c',
      action: 'skipped-existing-pr',
      prUrl: 'https://p/c',
      reviewers: [],
    },
    { repo: 'org/d', action: 'failed', error: 'boom' },
    {
      repo: 'org/e',
      action: 'dry-run',
      reviewers: ['@y'],
      unresolvedOwner: false,
    },
  ]

  it('renders the outputs and the job summary', () => {
    const { outputs, summary } = report(results)

    assert.deepEqual(JSON.parse(outputs.results_json), results)
    assert.equal(outputs.should_notify, 'true')
    assert.equal(outputs.slack_status, 'failure')
    assert.match(outputs.slack_text, /\*Failed repos:\*\n1\. org\/d — boom/)
    assert.match(
      outputs.slack_text,
      /\*Pre-existing PRs:\*\n1\. <https:\/\/p\/c> — no reviewer assigned/
    )
    assert.match(
      outputs.slack_text,
      /\*Opened PRs:\*\n1\. <https:\/\/p\/b> — reviewer\(s\): @x/
    )
    assert.doesNotMatch(outputs.slack_text, /dry run/i)

    assert.match(summary, /## Summary/)
    assert.match(summary, /5 repo\(s\) checked/)
    assert.match(
      summary,
      /\*Would open PRs \(dry run\):\*\n1\. org\/e — reviewer\(s\): @y/
    )
    assert.match(summary, /\*Failed repos:\*/)
  })

  it('does not notify when nothing was opened or failed', () => {
    const { outputs } = report([results[0], results[2], results[4]])
    assert.equal(outputs.should_notify, 'false')
    assert.equal(outputs.slack_status, 'warning')
  })
})
