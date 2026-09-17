import picomatch from 'picomatch'

import type { Change, CodeownersLine, FileContent } from './types.ts'

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
  if (s.startsWith('**/')) {
    s = s.slice(3)
  }
  if (s.startsWith('/')) {
    s = s.slice(1)
  }
  if (s.endsWith('/')) {
    s = s.slice(0, -1)
  }
  return s
}

function codeownersPatternCovers(
  pattern: string,
  normalisedRequired: string,
  requiredIsDirectory: boolean
): boolean {
  if (pattern === normalisedRequired) {
    return true
  }
  if (pattern === '*' || pattern === '.' || pattern === '') {
    return true
  }
  if (normalisedRequired.startsWith(`${pattern}/`)) {
    return true
  }
  // A required directory (e.g. `/.github/workflows/`) is covered by
  // existing entries like `/.github/workflows/*` or `…/**`.
  if (
    requiredIsDirectory &&
    (pattern === `${normalisedRequired}/*` ||
      pattern === `${normalisedRequired}/**`)
  ) {
    return true
  }
  // Glob support via picomatch — lets entries like
  // `docker-compose.*` cover `docker-compose.yml` /
  // `docker-compose.yaml`. `dot: true` so `*` matches
  // dot-prefixed names (CODEOWNERS doesn’t treat them
  // specially). CODEOWNERS also supports `?` and `[…]`.
  return (
    /[*?[\]]/.test(pattern) &&
    picomatch.isMatch(normalisedRequired, pattern, { dot: true })
  )
}

const GLOB_CHARS = /[*?]/

/**
 * Translate a CODEOWNERS pattern into the picomatch globs it stands
 * for, following the gitignore-like rules documented at
 * https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners#codeowners-syntax
 *
 * - A leading `/` anchors the pattern to the repository root.
 * - A pattern with a slash anywhere but the end is anchored as well.
 * - A pattern without one matches at any depth.
 * - A trailing `/` names a directory and covers everything inside.
 * - A pattern whose last segment has no glob characters covers the
 *   path itself and, when it is a directory, everything inside it.
 *   `docs/*` on the other hand only covers files directly in `docs`.
 * - Character ranges (`[…]`) are not supported by GitHub, which skips
 *   such a rule. It translates to no globs at all, so it matches
 *   nothing rather than what picomatch would make of the brackets.
 */
export function convertCodeownersPatternToGlobs(
  pattern: string
): Array<string> {
  let p = pattern
  if (/[[\]]/.test(p)) {
    return []
  }
  const withoutTrailingSlash = p.endsWith('/') ? p.slice(0, -1) : p
  const anchored = p.startsWith('/') || withoutTrailingSlash.includes('/')
  if (p.startsWith('/')) {
    p = p.slice(1)
  }
  if (!anchored) {
    p = `**/${p}`
  }
  if (p.endsWith('/')) {
    return [`${p}**`]
  }
  const lastSegment = p.slice(p.lastIndexOf('/') + 1)
  if (GLOB_CHARS.test(lastSegment)) {
    return [p]
  }
  return [p, `${p}/**`]
}

/**
 * Owners of a single file, or `null` when no rule matches. The last
 * matching rule wins; a matching rule with no owners yields `[]`.
 */
export function findCodeownersFor(
  file: string,
  parsedLines: Array<CodeownersLine>
): Array<string> | null {
  const path = file.replace(/^\//, '')
  for (const line of parsedLines.toReversed()) {
    const globs = convertCodeownersPatternToGlobs(line.pattern)
    // `dot: true` so `*` matches dot-prefixed names (CODEOWNERS does
    // not treat them specially).
    if (picomatch.isMatch(path, globs, { dot: true })) {
      return line.owners
    }
  }
  return null
}

/**
 * Union of the owners of all `files`, in the order they are first
 * encountered.
 */
export function collectCodeownersForFiles(
  files: Array<string>,
  parsedLines: Array<CodeownersLine>
): Array<string> {
  const owners = new Set<string>()
  for (const file of files) {
    for (const owner of findCodeownersFor(file, parsedLines) || []) {
      owners.add(owner)
    }
  }
  return [...owners]
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
  const normalisedRequired = normalisePattern(required)
  const requiredIsDirectory = required.endsWith('/')
  for (const line of existingLines.toReversed()) {
    if (
      codeownersPatternCovers(
        normalisePattern(line.pattern),
        normalisedRequired,
        requiredIsDirectory
      )
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

/**
 * The last existing line that already covers any required pattern, or
 * -1. New lines get inserted right after it (no blank-line separator,
 * no header comment) so they sit next to their relatives.
 */
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

/**
 * Splice `addedLines` into `text` after line `insertAfterIdx`, or
 * append them after a blank line when there is no such line.
 */
function spliceLines(
  text: string,
  addedLines: Array<string>,
  insertAfterIdx: number
): Array<string> {
  const baseLines = text.split('\n')
  // split on a string ending with \n leaves a trailing empty element;
  // drop it for clean splicing.
  if (baseLines.length > 0 && baseLines[baseLines.length - 1] === '') {
    baseLines.pop()
  }

  if (insertAfterIdx >= 0) {
    return [
      ...baseLines.slice(0, insertAfterIdx + 1),
      ...addedLines,
      ...baseLines.slice(insertAfterIdx + 1),
    ]
  }
  if (baseLines.length > 0) {
    return [...baseLines, '', ...addedLines]
  }
  return [...addedLines]
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
 * owned by `ownerToken`. Returns the change object the audit commits.
 */
export function buildCodeownersAddition({
  existing,
  parsedLines,
  requiredPatterns,
  missingPatterns,
  ownerToken,
}: CodeownersAdditionParams): Change {
  const insertAfterIdx = findInsertAfterIdx(requiredPatterns, parsedLines)
  const includeHeader = insertAfterIdx === -1

  const addedLines = [
    ...(includeHeader
      ? ['# Make sure dependabot PRs get reviewers assigned']
      : []),
    ...missingPatterns.map((pat) => `${pat}  ${ownerToken}`),
  ]

  const combinedLines = spliceLines(
    existing ? existing.content : '',
    addedLines,
    insertAfterIdx
  )

  const listed = missingPatterns.map((p) => `\`${p}\``).join(', ')

  return {
    path: existing ? existing.path : 'CODEOWNERS',
    sha: existing ? existing.sha : undefined,
    newContent: `${combinedLines.join('\n')}\n`,
    summary: existing
      ? `added ${missingPatterns.length} line(s) to \`${existing.path}\`: ${listed}`
      : `created \`CODEOWNERS\` with ${missingPatterns.length} line(s): ${listed}`,
  }
}
