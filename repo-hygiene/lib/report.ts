import * as core from '@actions/core'

import type { Finding } from './types.ts'

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

/**
 * The newline is included, so section costs add up to the length of the
 * joined text.
 */
function measureLines(lines: Array<string>): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0)
}

function renderList(heading: string, items: Array<string>): Array<string> {
  return ['', heading, ...items.map((item, idx) => `${idx + 1}. ${item}`)]
}

/** One line standing in for a section we have no room to list. */
function renderCountLabel({ heading, items }: Section): Array<string> {
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
    if (measureLines(lines) > budget) {
      break
    }
    kept = next
  }
  if (kept.length === items.length) {
    return renderList(heading, items)
  }
  if (!partial || kept.length === 0) {
    return renderCountLabel(section)
  }
  return [...renderList(heading, kept), noteFor(items.length - kept.length)]
}

interface SlackTextParams<K extends string> {
  sections: Record<K, Section>
  fillOrder: ReadonlyArray<{ key: K; partial: boolean }>
  showOrder: ReadonlyArray<K>
  /** Link to the run; the footer pointing at it is dropped when absent. */
  runUrl?: string
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
  const footerLines = runUrl
    ? ['', `<${runUrl}|See full list with more details>`]
    : []
  const listed = (Object.values(sections) as Array<Section>).filter(
    ({ items }) => items.length > 0
  )
  // Reserve the footer and every section’s count label up front, so
  // each section is guaranteed at least its count. A section gets its
  // own reserve back when its turn comes; what the others leave unspent
  // stays as a buffer.
  let budget =
    SLACK_MAX_CHARS -
    measureLines(footerLines) -
    listed.reduce(
      (sum, section) => sum + measureLines(renderCountLabel(section)),
      0
    )
  const filled = {} as Record<K, Array<string>>
  for (const { key, partial } of fillOrder) {
    const section = sections[key]
    if (section.items.length === 0) {
      filled[key] = []
    } else {
      const reserve = measureLines(renderCountLabel(section))
      filled[key] = fillSection(section, budget + reserve, { partial })
      budget += reserve - measureLines(filled[key])
    }
  }
  return [...showOrder.flatMap((key) => filled[key]), ...footerLines].join('\n')
}

export interface Outputs {
  results_json: string
  slack_text: string
  should_notify: 'true' | 'false'
  slack_status: 'warning' | 'failure'
}

export interface ReportOptions {
  repoCount: number
  dryRun: boolean
  /** Rendered dry-run PRs, one per repo. */
  previews: Array<string>
  runUrl?: string
}

/** Report groups with their headings, in the order they are shown. */
const HEADINGS = {
  failed: '*💥 Failed:*',
  attention: '*⚠️ Needs attention:*',
  opened: '*🆕 Opened PRs:*',
  fixed: '*🔧 Fixed:*',
  previous: '*🥶 Previously opened PRs:*',
} satisfies Record<string, string>

type GroupKey = keyof typeof HEADINGS

const GROUP_ORDER = Object.keys(HEADINGS) as ReadonlyArray<GroupKey>

const DRY_RUN_HEADINGS: Partial<Record<GroupKey, string>> = {
  opened: '*🆕 Would open PRs (dry run):*',
  fixed: '*🔧 Would fix (dry run):*',
}

/** Sections that list half their items when short of room; the rest collapse to a count. */
const PARTIAL: Record<GroupKey, boolean> = {
  failed: true,
  attention: true,
  opened: true,
  fixed: true,
  previous: false,
}

const MAX_DETAILS = 5

function classifyFinding(finding: Finding): GroupKey | null {
  const status = finding.outcome?.status ?? 'none'
  if (status === 'failed' || finding.level === 'error') {
    return 'failed'
  }
  if (status === 'skipped') {
    return 'previous'
  }
  if (status === 'fixed' || status === 'would-fix') {
    return finding.fix?.kind === 'file' ? 'opened' : 'fixed'
  }
  if (finding.level === 'warning' || finding.fix) {
    return 'attention'
  }
  return null
}

/** `repo` or `repo: <url>`. */
function formatLocation(finding: Finding): string {
  const url = finding.outcome?.url ?? finding.url
  return url ? `${finding.repo}: <${url}>` : finding.repo
}

/** At most `MAX_DETAILS` items, then a count of the rest. */
function formatDetails(details: Array<string>): string {
  const shown = details.slice(0, MAX_DETAILS)
  const rest = details.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
}

function formatFindingLine(
  finding: Finding,
  { summary, details }: { summary: boolean; details: boolean }
): string {
  const parts = [formatLocation(finding)]
  if (summary) {
    parts.push(finding.summary)
  }
  if (finding.outcome?.detail) {
    parts.push(finding.outcome.detail)
  }
  if (details && finding.details && finding.details.length > 0) {
    parts.push(formatDetails(finding.details))
  }
  return parts.join(' — ')
}

/** One item per finding, except Opened PRs, which is one per repo. */
function renderGroupItems(
  group: GroupKey,
  findings: Array<Finding>,
  { details }: { details: boolean }
): Array<string> {
  if (group === 'opened' || group === 'previous') {
    const seen = new Set<string>()
    return findings.flatMap((f) => {
      const key = group === 'opened' ? f.repo : formatLocation(f)
      if (seen.has(key)) {
        return []
      }
      seen.add(key)
      return [formatFindingLine(f, { summary: false, details: false })]
    })
  }
  return findings.map((f) => formatFindingLine(f, { summary: true, details }))
}

function pickGroupHeading(group: GroupKey, findings: Array<Finding>): string {
  const dry = findings.some((f) => f.outcome?.status === 'would-fix')
  return (dry && DRY_RUN_HEADINGS[group]) || HEADINGS[group]
}

/** `results_json`’s shape: every field but the fix. */
function getFindingsNotifyData({
  repo,
  check,
  level,
  summary,
  url,
  details,
  reviewers,
  outcome,
}: Finding): Omit<Finding, 'fix'> {
  return { repo, check, level, summary, url, details, reviewers, outcome }
}

/** The action outputs and job summary for `findings`. */
export function report(
  findings: Array<Finding>,
  { repoCount, dryRun, previews, runUrl }: ReportOptions
): { outputs: Outputs; summary: string } {
  const groups = Object.fromEntries(
    GROUP_ORDER.map((key) => [key, [] as Array<Finding>])
  ) as Record<GroupKey, Array<Finding>>
  for (const finding of findings) {
    const group = classifyFinding(finding)
    if (group) {
      groups[group].push(finding)
    }
  }

  const summaryLines = GROUP_ORDER.flatMap((key) =>
    groups[key].length > 0
      ? renderList(
          pickGroupHeading(key, groups[key]),
          renderGroupItems(key, groups[key], { details: true })
        )
      : []
  )

  const slackText = renderSlackText({
    sections: Object.fromEntries(
      GROUP_ORDER.map((key) => [
        key,
        {
          heading: pickGroupHeading(key, groups[key]),
          // Failed lines carry the error itself as `details`, so Slack
          // keeps it; other groups’ `details` are the extra context
          // that only the job summary has room for.
          items: renderGroupItems(key, groups[key], {
            details: key === 'failed',
          }),
        },
      ])
    ) as Record<GroupKey, { heading: string; items: Array<string> }>,
    fillOrder: GROUP_ORDER.map((key) => ({ key, partial: PARTIAL[key] })),
    showOrder: GROUP_ORDER,
    runUrl,
  })

  const notify =
    groups.failed.length + groups.opened.length + groups.fixed.length > 0
  const outputs: Outputs = {
    results_json: JSON.stringify(findings.map(getFindingsNotifyData)),
    slack_text: slackText,
    should_notify: notify ? 'true' : 'false',
    slack_status: groups.failed.length > 0 ? 'failure' : 'warning',
  }

  const summary = [
    '',
    '## Summary',
    '',
    `\`repo-hygiene\` run complete, ${repoCount} repo(s) checked.`,
    ...summaryLines,
    '',
    ...previews.flatMap((preview) => ['', preview]),
    ...(dryRun || !notify
      ? [
          '',
          '## Slack message',
          '',
          '<details>',
          `<summary>Not sent: ${dryRun ? 'dry run' : 'nothing to notify about'}</summary>`,
          '',
          '```',
          slackText,
          '```',
          '',
          '</details>',
          '',
        ]
      : []),
  ].join('\n')

  return { outputs, summary }
}

/** Write the outputs and the job summary for the run. */
export async function publish(
  findings: Array<Finding>,
  options: Omit<ReportOptions, 'runUrl'>
): Promise<void> {
  const runUrl = [
    process.env.GITHUB_SERVER_URL,
    process.env.GITHUB_REPOSITORY,
    'actions/runs',
    process.env.GITHUB_RUN_ID,
  ].join('/')
  const { outputs, summary } = report(findings, { ...options, runUrl })
  for (const [name, value] of Object.entries(outputs)) {
    core.setOutput(name, value)
  }
  await core.summary.addRaw(summary).write()
}
