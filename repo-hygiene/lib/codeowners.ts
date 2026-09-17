import picomatch from 'picomatch'

import type { CodeownersChange, CodeownersLine, FileContent } from './types.ts'

/**
 * Parse a CODEOWNERS file into `{ pattern, owners, rawIndex }` lines.
 * Comments and blank lines are dropped. `rawIndex` is the zero-based
 * line number in the original text.
 */
export function parseCodeowners(
  text: string | null | undefined
): Array<CodeownersLine> {
  const out: Array<CodeownersLine> = []
  const lines = (text ?? '').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = lines[i].replace(/#.*$/, '').trim()
    if (stripped) {
      const [pattern, ...owners] = stripped.split(/\s+/)
      out.push({ pattern, owners, rawIndex: i })
    }
  }
  return out
}

function normalisePattern(p: string): string {
  let s = p
  if (s.startsWith('**/')) s = s.slice(3)
  if (s.startsWith('/')) s = s.slice(1)
  if (s.endsWith('/')) s = s.slice(0, -1)
  return s
}

function codeownersPatternCovers(
  pat: string,
  reqNorm: string,
  reqIsDir: boolean
): boolean {
  if (pat === reqNorm) return true
  if (pat === '*' || pat === '.' || pat === '') return true
  if (reqNorm.startsWith(`${pat}/`)) return true
  // A required directory (e.g. `/.github/workflows/`) is covered by
  // existing entries like `/.github/workflows/*` or `…/**`.
  if (reqIsDir && (pat === `${reqNorm}/*` || pat === `${reqNorm}/**`)) {
    return true
  }
  // Glob support via picomatch — lets entries like
  // `docker-compose.*` cover `docker-compose.yml` /
  // `docker-compose.yaml`. `dot: true` so `*` matches
  // dot-prefixed names (CODEOWNERS doesn’t treat them
  // specially). CODEOWNERS also supports `?` and `[…]`.
  return /[*?[\]]/.test(pat) && picomatch.isMatch(reqNorm, pat, { dot: true })
}

/**
 * The existing line that covers a `required` pattern, or `null`.
 * CODEOWNERS uses the LAST matching pattern, per
 * https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners#codeowners-syntax
 */
export function findCoveringLine(
  required: string,
  existingLines: Array<CodeownersLine>
): CodeownersLine | null {
  const reqNorm = normalisePattern(required)
  const reqIsDir = required.endsWith('/')
  for (const line of existingLines.toReversed()) {
    if (
      codeownersPatternCovers(normalisePattern(line.pattern), reqNorm, reqIsDir)
    ) {
      return line
    }
  }
  return null
}

/**
 * The existing line that gives a `required` pattern an owner, or
 * `null`. A covering line without owners (GitHub’s syntax for clearing
 * ownership) counts as no coverage, since nobody would get requested
 * as a reviewer.
 */
export function findOwningLine(
  required: string,
  existingLines: Array<CodeownersLine>
): CodeownersLine | null {
  const line = findCoveringLine(required, existingLines)
  return line && line.owners.length > 0 ? line : null
}

// The last existing line that already covers any required pattern, or
// -1. New lines get inserted right after it (no blank-line separator,
// no header comment) so they sit next to their relatives.
function findInsertAfterIdx(
  requiredPatterns: Array<string>,
  parsedLines: Array<CodeownersLine>
): number {
  let insertAfterIdx = -1
  for (const req of requiredPatterns) {
    const match = findCoveringLine(req, parsedLines)
    if (match && match.rawIndex > insertAfterIdx) {
      insertAfterIdx = match.rawIndex
    }
  }
  return insertAfterIdx
}

// Splice `addedLines` into `text` after line `insertAfterIdx`, or
// append them after a blank line when there is no such line. Also
// returns the 1-indexed line of the first added pattern.
function spliceLines(
  text: string,
  addedLines: Array<string>,
  insertAfterIdx: number,
  includeHeader: boolean
): { combinedLines: Array<string>; patternStartLine: number } {
  const baseLines = text.split('\n')
  // split on a string ending with \n leaves a trailing empty element;
  // drop it for clean splicing.
  if (baseLines.length > 0 && baseLines[baseLines.length - 1] === '') {
    baseLines.pop()
  }

  if (insertAfterIdx >= 0) {
    return {
      combinedLines: [
        ...baseLines.slice(0, insertAfterIdx + 1),
        ...addedLines,
        ...baseLines.slice(insertAfterIdx + 1),
      ],
      // No header in this branch; first added line is the first pattern.
      patternStartLine: insertAfterIdx + 2,
    }
  }
  const headerLines = includeHeader ? 1 : 0
  if (baseLines.length > 0) {
    return {
      combinedLines: [...baseLines, '', ...addedLines],
      patternStartLine: baseLines.length + 1 /* blank */ + headerLines + 1,
    }
  }
  return { combinedLines: [...addedLines], patternStartLine: headerLines + 1 }
}

interface CodeownersAdditionParams {
  existing: FileContent | null
  parsedLines: Array<CodeownersLine>
  requiredPatterns: Array<string>
  missingPatterns: Array<string>
  ownerToken: string
}

/**
 * New CODEOWNERS content with lines for `missingPatterns` added, each
 * owned by `ownerToken`. Returns the change object the audit commits,
 * including the 1-indexed line number of every added pattern so a
 * review comment can point at them.
 */
export function buildCodeownersAddition({
  existing,
  parsedLines,
  requiredPatterns,
  missingPatterns,
  ownerToken,
}: CodeownersAdditionParams): CodeownersChange {
  const insertAfterIdx = findInsertAfterIdx(requiredPatterns, parsedLines)
  const includeHeader = insertAfterIdx === -1

  const addedLines = [
    ...(includeHeader
      ? ['# Make sure dependabot PRs get reviewers assigned']
      : []),
    ...missingPatterns.map((pat) => `${pat}  ${ownerToken}`),
  ]

  const { combinedLines, patternStartLine } = spliceLines(
    existing ? existing.content : '',
    addedLines,
    insertAfterIdx,
    includeHeader
  )

  const listed = missingPatterns.map((p) => `\`${p}\``).join(', ')

  return {
    path: existing ? existing.path : 'CODEOWNERS',
    sha: existing ? existing.sha : undefined,
    newContent: `${combinedLines.join('\n')}\n`,
    missingLines: missingPatterns.map((pat, i) => ({
      pattern: pat,
      lineNumber: patternStartLine + i,
      ownerToken,
    })),
    addedLines,
    summary: existing
      ? `added ${missingPatterns.length} line(s) to \`${existing.path}\`: ${listed}`
      : `created \`CODEOWNERS\` with ${missingPatterns.length} line(s): ${listed}`,
  }
}
