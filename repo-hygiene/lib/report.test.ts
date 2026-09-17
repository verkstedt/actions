import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { renderSlackText, report } from './report.ts'
import type { Finding } from './types.ts'

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
        `<${runUrl}|See full list with more details>`,
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
        `<${runUrl}|See full list with more details>`,
      ].join('\n')
    )
  })
})

describe('report', () => {
  const options = { repoCount: 5, dryRun: false, previews: [], runUrl }
  const findings: Array<Finding> = [
    {
      repo: 'org/legacy',
      level: 'error',
      summary: 'could not list open PRs',
      details: ['Resource not accessible by integration'],
      outcome: { status: 'none' },
    },
    {
      repo: 'org/api',
      level: 'warning',
      summary: 'Dependabot PR has no reviewers and CODEOWNERS names nobody',
      url: 'https://p/121',
      details: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      outcome: { status: 'none' },
    },
    {
      repo: 'org/api',
      level: 'info',
      summary: 'Dependabot PR has no reviewers',
      url: 'https://p/119',
      fix: {
        kind: 'action',
        describe: 'request @gone',
        run: async () => undefined,
      },
      outcome: { status: 'none', detail: 'none of @gone could be requested' },
    },
    {
      repo: 'org/shop',
      level: 'info',
      summary: 'dependabot config missing',
      fix: {
        kind: 'file',
        path: 'a',
        content: '',
        lang: '',
        describe: 'created a',
      },
      outcome: {
        status: 'fixed',
        url: 'https://p/42',
        detail: 'reviewers: @alice, @org/web',
      },
    },
    {
      repo: 'org/shop',
      level: 'info',
      summary: 'CODEOWNERS lacks owners',
      fix: {
        kind: 'file',
        path: 'b',
        content: '',
        lang: '',
        describe: 'added b',
      },
      outcome: {
        status: 'fixed',
        url: 'https://p/42',
        detail: 'reviewers: @alice, @org/web',
      },
    },
    {
      repo: 'org/api',
      level: 'info',
      summary: 'Dependabot PR has no reviewers',
      url: 'https://p/118',
      fix: {
        kind: 'action',
        describe: 'request @bob',
        run: async () => undefined,
      },
      outcome: { status: 'fixed', detail: 'requested @bob' },
    },
    {
      repo: 'org/docs',
      level: 'info',
      summary: 'hygiene PR already open',
      url: 'https://p/7',
      outcome: {
        status: 'skipped',
        url: 'https://p/7',
        detail: 'reviewer: @carol',
      },
    },
    {
      repo: 'org/quiet',
      level: 'info',
      summary: 'dependabot config is complete',
      outcome: { status: 'none' },
    },
    {
      repo: 'org/broken',
      level: 'info',
      summary: 'add x',
      fix: { kind: 'file', path: 'x', content: '', lang: '', describe: 'x' },
      outcome: { status: 'failed', detail: 'forbidden' },
    },
  ]

  it('renders the job summary grouped by importance', () => {
    const { summary } = report(findings, options)
    assert.equal(
      summary,
      [
        '',
        '## Summary',
        '',
        '`repo-hygiene` run complete, 5 repo(s) checked.',
        '',
        '*💥 Failed:*',
        '1. org/legacy — could not list open PRs — Resource not accessible by integration',
        '2. org/broken — add x — forbidden',
        '',
        '*⚠️ Needs attention:*',
        '1. org/api: <https://p/121> — Dependabot PR has no reviewers and CODEOWNERS names nobody — a, b, c, d, e and 2 more',
        '2. org/api: <https://p/119> — Dependabot PR has no reviewers — none of @gone could be requested',
        '',
        '*🆕 Opened PRs:*',
        '1. org/shop: <https://p/42> — reviewers: @alice, @org/web',
        '',
        '*🔧 Fixed:*',
        '1. org/api: <https://p/118> — Dependabot PR has no reviewers — requested @bob',
        '',
        '*🥶 Previously opened PRs:*',
        '1. org/docs: <https://p/7> — reviewer: @carol',
        '',
      ].join('\n')
    )
  })

  it('renders the same groups for Slack without details, and sets the outputs', () => {
    const { outputs } = report(findings, options)
    assert.equal(outputs.should_notify, 'true')
    assert.equal(outputs.slack_status, 'failure')
    assert.match(
      outputs.slack_text,
      /\*💥 Failed:\*\n1\. org\/legacy — could not list open PRs — Resource/
    )
    assert.match(outputs.slack_text, /names nobody\n2\. org\/api/)
    assert.doesNotMatch(outputs.slack_text, /names nobody — a, b/)
    assert.match(
      outputs.slack_text,
      /<https:\/\/example\.test\/run\/1\|See full list with more details>$/
    )
    const json = JSON.parse(outputs.results_json)
    assert.equal(json.length, findings.length)
    assert.equal('fix' in json[3], false)
    assert.deepEqual(json[3].outcome, findings[3].outcome)
  })

  it('does not notify when only previously opened PRs and warnings remain', () => {
    const { outputs, summary } = report([findings[1], findings[6]], options)
    assert.equal(outputs.should_notify, 'false')
    assert.equal(outputs.slack_status, 'warning')
    assert.match(
      summary,
      /## Slack message\n\n<details>\n<summary>Not sent: nothing to notify about<\/summary>\n\n```\n/
    )
  })

  it('switches the fix headings in a dry run and shows the previews and the Slack text', () => {
    const dry = findings.map((f) =>
      f.outcome?.status === 'fixed'
        ? {
            ...f,
            outcome: { status: 'would-fix' as const, detail: f.fix?.describe },
          }
        : f
    )
    const { summary, outputs } = report(dry, {
      ...options,
      dryRun: true,
      previews: ['### `org/shop`: chore: Repo hygiene\n…\n'],
    })
    assert.match(
      summary,
      /\*🆕 Would open PRs \(dry run\):\*\n1\. org\/shop — created a\n/
    )
    assert.match(
      summary,
      /\*🔧 Would fix \(dry run\):\*\n1\. org\/api: <https:\/\/p\/118> — Dependabot PR has no reviewers — request @bob\n/
    )
    assert.match(summary, /\n### `org\/shop`: chore: Repo hygiene\n…\n/)
    assert.match(
      summary,
      /## Slack message\n\n<details>\n<summary>Not sent: dry run<\/summary>/
    )
    assert.match(outputs.slack_text, /Would open PRs \(dry run\)/)
  })
})
