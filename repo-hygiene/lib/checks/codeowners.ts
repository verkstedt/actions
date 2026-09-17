import {
  buildCodeownersAddition,
  findCoveringLine,
  findOwningLine,
  parseCodeowners,
} from '../codeowners.ts'
import { detectEcosystems } from '../dependabot-config.ts'
import { createLineComment } from '../github.ts'
import { CODEOWNERS_PATHS } from '../reviewers.ts'
import type { Check, CheckFinding } from '../types.ts'

const OWNER_PLACEHOLDER = '@OWNER'
const PLACEHOLDER_COMMENT =
  'Failed to guess who the owner should be — please replace the `@OWNER` placeholder with one or more people.'

/** 1-indexed numbers of the lines that end in the placeholder. */
function findPlaceholderLines(content: string): Array<number> {
  return content
    .split('\n')
    .flatMap((line, index) =>
      line.trimEnd().endsWith(`  ${OWNER_PLACEHOLDER}`) ? [index + 1] : []
    )
}

/**
 * Every file dependabot will touch has an owner in CODEOWNERS, so its
 * PRs get reviewers. Owners come from lines that already cover a
 * required pattern; failing that the lines get `@OWNER` and a review
 * comment asks for a real one.
 */
export const codeowners: Check = {
  name: 'codeowners',
  opensPr: true,
  run: async (snapshot) => {
    const { requiredCodeowners } = detectEcosystems(await snapshot.listPaths())
    const existing = await snapshot.readFirstExistingFile(CODEOWNERS_PATHS)
    const parsedLines = parseCodeowners(existing ? existing.content : '')

    const matchedOwners = new Set<string>()
    for (const required of requiredCodeowners) {
      findCoveringLine(required, parsedLines)?.owners.forEach((owner) =>
        matchedOwners.add(owner)
      )
    }
    const reviewers = matchedOwners.size > 0 ? [...matchedOwners] : undefined

    const missing = requiredCodeowners.filter(
      (required) => !findOwningLine(required, parsedLines)
    )
    if (missing.length === 0) {
      return [
        {
          level: 'info',
          summary: 'CODEOWNERS covers every dependabot file',
          reviewers,
        },
      ]
    }

    // Space-joined when there are several, matching the multi-owner syntax.
    const ownerToken = reviewers ? reviewers.join(' ') : OWNER_PLACEHOLDER
    const addition = buildCodeownersAddition({
      existing,
      parsedLines,
      requiredPatterns: requiredCodeowners,
      missingPatterns: missing,
      ownerToken,
    })
    const findings: Array<CheckFinding> = [
      {
        level: 'info',
        summary: `CODEOWNERS lacks owners for ${missing.map((p) => `\`${p}\``).join(', ')}`,
        reviewers,
        fix: {
          kind: 'file',
          path: addition.path,
          content: addition.newContent,
          lang: '',
          describe: addition.summary,
        },
      },
    ]
    if (!reviewers) {
      findings.push({
        level: 'warning',
        summary: 'added CODEOWNERS lines use the `@OWNER` placeholder',
        fix: {
          kind: 'action',
          afterPr: true,
          describe: 'comment on the `@OWNER` lines asking for a real owner',
          run: async ({ octokit, org, repo, pr, files }) => {
            if (!pr) {
              throw new Error('hygiene PR was not opened')
            }
            const lineNumbers = findPlaceholderLines(files[addition.path] ?? '')
            if (lineNumbers.length === 0) {
              return {
                fixed: false,
                detail: 'no `@OWNER` line left to comment on',
              }
            }
            await createLineComment(octokit, {
              org,
              repo,
              pr,
              path: addition.path,
              lineNumbers,
              body: PLACEHOLDER_COMMENT,
            })
            return 'commented on the `@OWNER` lines'
          },
        },
      })
    }
    return findings
  },
}
