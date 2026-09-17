import type { Result, ResultOf } from './types.ts'

/**
 * Slack renders the whole summary inside a single Block Kit `section`
 * block, whose text is capped at 3000 characters, per
 * https://docs.slack.dev/reference/block-kit/blocks/section-block
 * About 400 of those go to the header `notify-status` composes around
 * our text, which we cannot measure from here.
 */
const SLACK_MAX_CHARS = 2600

interface Section {
  heading: string
  items: Array<string>
}

// The newline is included, so section costs add up to the length of the
// joined text.
function linesCost(lines: Array<string>): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0)
}

function renderList(heading: string, items: Array<string>): Array<string> {
  return ['', heading, ...items.map((item, idx) => `${idx + 1}. ${item}`)]
}

// One line standing in for a section we have no room to list.
function countLabel({ heading, items }: Section): Array<string> {
  return ['', `${heading} ${items.length} — see the run summary`]
}

/**
 * As many of a section’s items as `budget` allows, ending in a note
 * counting the rest. A section that does not fit at all — or one asked
 * not to list `partial`ly, where half a list would be noise — collapses
 * to its count label instead.
 */
function fillSection(
  section: Section,
  budget: number,
  { partial }: { partial: boolean }
): Array<string> {
  const { heading, items } = section
  const noteFor = (left: number) => `… and ${left} more`
  let kept: Array<string> = []
  for (const item of items) {
    const next = [...kept, item]
    const left = items.length - next.length
    const lines = [
      ...renderList(heading, next),
      ...(left > 0 ? [noteFor(left)] : []),
    ]
    if (linesCost(lines) > budget) break
    kept = next
  }
  if (kept.length === items.length) return renderList(heading, items)
  if (!partial || kept.length === 0) return countLabel(section)
  return [...renderList(heading, kept), noteFor(items.length - kept.length)]
}

interface SlackTextParams<K extends string> {
  sections: Record<K, Section>
  fillOrder: ReadonlyArray<{ key: K; partial: boolean }>
  showOrder: ReadonlyArray<K>
  runUrl: string
}

/**
 * Slack text for the run: `sections` (keyed, each `{ heading, items }`)
 * fitted into one section block. Sections are filled in `fillOrder`
 * and shown in `showOrder`; whatever does not fit collapses to a count
 * pointing at the run summary.
 */
export function renderSlackText<K extends string>({
  sections,
  fillOrder,
  showOrder,
  runUrl,
}: SlackTextParams<K>): string {
  const footerLines = ['', `<${runUrl}|Full list in the run summary>`]
  const listed = (Object.values(sections) as Array<Section>).filter(
    ({ items }) => items.length > 0
  )
  // Reserve the footer and every section’s count label up front, so
  // each section is guaranteed at least its count. A section gets its
  // own reserve back when its turn comes; what the others leave unspent
  // stays as a buffer.
  let budget =
    SLACK_MAX_CHARS -
    linesCost(footerLines) -
    listed.reduce((sum, section) => sum + linesCost(countLabel(section)), 0)
  const filled = {} as Record<K, Array<string>>
  for (const { key, partial } of fillOrder) {
    const section = sections[key]
    if (section.items.length === 0) {
      filled[key] = []
    } else {
      const reserve = linesCost(countLabel(section))
      filled[key] = fillSection(section, budget + reserve, { partial })
      budget += reserve - linesCost(filled[key])
    }
  }
  return [...showOrder.flatMap((key) => filled[key]), ...footerLines].join('\n')
}

// The results of one kind, narrowed to that kind’s shape.
function ofAction<A extends Result['action']>(
  results: Array<Result>,
  action: A
): Array<ResultOf<A>> {
  return results.filter((r): r is ResultOf<A> => r.action === action)
}

export interface Outputs {
  results_json: string
  slack_text: string
  should_notify: 'true' | 'false'
  slack_status: 'warning' | 'failure'
}

/**
 * The action outputs and job summary for `results`, as `{ outputs,
 * summary }`. `outputs` maps output names to their string values.
 */
export function report(results: Array<Result>): {
  outputs: Outputs
  summary: string
} {
  const opened = ofAction(results, 'opened-pr')
  const failed = ofAction(results, 'failed')
  const dryRuns = ofAction(results, 'dry-run')
  const preexisting = ofAction(results, 'skipped-existing-pr')

  const reviewerSummary = (r: { reviewers: Array<string> }) =>
    r.reviewers.length > 0
      ? `reviewer(s): ${r.reviewers.join(', ')}`
      : 'no reviewer assigned'

  const prItem = (r: { prUrl: string; reviewers: Array<string> }) =>
    `<${r.prUrl}> — ${reviewerSummary(r)}`
  const openedItems = opened.map(prItem)
  const preexistingItems = preexisting.map(prItem)
  const dryRunItems = dryRuns.map((r) => `${r.repo} — ${reviewerSummary(r)}`)
  const failedItems = failed.map((r) => `${r.repo} — ${r.error}`)

  const HEADINGS = {
    opened: '*Opened PRs:*',
    preexisting: '*Pre-existing PRs:*',
    dryRun: '*Would open PRs (dry run):*',
    failed: '*Failed repos:*',
  }

  // The job summary lists everything.
  const listIfAny = (heading: string, items: Array<string>) =>
    items.length > 0 ? renderList(heading, items) : []
  const lines = [
    ...listIfAny(HEADINGS.opened, openedItems),
    ...listIfAny(HEADINGS.preexisting, preexistingItems),
    ...listIfAny(HEADINGS.dryRun, dryRunItems),
    ...listIfAny(HEADINGS.failed, failedItems),
  ]

  // Slack gets the same lists, fitted into one section block. Sections
  // are filled in order of importance — failures, then opened, then
  // pre-existing — and shown in a different order, with the failures
  // first and the longest list last. Dry runs are left out: the workflow
  // does not notify on a dry run.
  const runUrl = [
    process.env.GITHUB_SERVER_URL,
    process.env.GITHUB_REPOSITORY,
    'actions/runs',
    process.env.GITHUB_RUN_ID,
  ].join('/')
  const slackText = renderSlackText({
    sections: {
      failed: { heading: HEADINGS.failed, items: failedItems },
      opened: { heading: HEADINGS.opened, items: openedItems },
      preexisting: { heading: HEADINGS.preexisting, items: preexistingItems },
    },
    fillOrder: [
      { key: 'failed', partial: true },
      { key: 'opened', partial: true },
      // A partial list of the least important PRs would be noise.
      { key: 'preexisting', partial: false },
    ],
    showOrder: ['failed', 'preexisting', 'opened'],
    runUrl,
  })
  const outputs: Outputs = {
    results_json: JSON.stringify(results),
    slack_text: slackText,
    should_notify: opened.length + failed.length > 0 ? 'true' : 'false',
    slack_status: failed.length > 0 ? 'failure' : 'warning',
  }

  const summary = [
    '',
    '## Summary',
    '',
    `\`repo-hygiene\` run complete (${results.length} repo(s) checked)`,
    '',
    ...lines,
    '',
  ].join('\n')

  return { outputs, summary }
}
