import type { getOctokit } from '@actions/github'
import type { Document, YAMLMap } from 'yaml'

export type Octokit = ReturnType<typeof getOctokit>

export type LogLevel = 'info' | 'warning' | 'error'

/** What a log line is about; nothing for run-wide lines. */
export interface LogContext {
  repo?: {
    name: string
    /** 1-based. */
    position: number
    total: number
  }
  check?: string
}

export interface LogEntry extends LogContext {
  level: LogLevel
  message: string
}

/** Where log entries end up; the entry points decide how to print them. */
export type LogSink = (entry: LogEntry) => void

/** What the code logs through; see `createLogger`. */
export interface Logger {
  info: (message: string) => void
  warning: (message: string) => void
  error: (message: string) => void
}

/** A text file: as fetched, or the working copy of one not yet committed. */
export interface FileContent {
  sha?: string
  path: string
  content: string
}

/** A file the hygiene PR commits. `sha` set means the file exists. */
export interface Change {
  path: string
  newContent: string
  sha?: string
  summary: string
}

/** One rule of a CODEOWNERS file; see `parseCodeowners`. */
export interface CodeownersLine {
  pattern: string
  owners: Array<string>
  rawIndex: number
}

/** The org-wide dependabot template; see `parseDependabotTemplate`. */
export interface DependabotTemplate {
  doc: Document
  entryByEcosystem: Map<string, YAMLMap>
}

export type ReviewerSource =
  'codeowners-match' | 'codeowners-fallback' | 'contributors' | 'none'

/**
 * The parts of GitHub API objects the audit reads. Structural so the
 * tests can pass literals; the real API objects are assignable.
 */
export namespace GitHub {
  export interface RepoMeta {
    name: string
    default_branch: string
  }

  export interface User {
    login: string
    type?: string
  }

  export interface Team {
    slug: string
  }

  export interface PullRequest {
    number: number
    html_url: string
    user?: User | null
    head: {
      ref: string
      sha: string
      repo?: { full_name: string } | null
    }
    requested_reviewers?: Array<User> | null
    requested_teams?: Array<Team> | null
  }
}

export type Level = 'info' | 'warning' | 'error'

export type OutcomeStatus =
  'fixed' | 'would-fix' | 'skipped' | 'failed' | 'none'

/** What the runner did about a finding. */
export interface Outcome {
  status: OutcomeStatus
  url?: string
  detail?: string
}

/** A whole new file for the repo’s hygiene PR. */
export interface FileFix {
  kind: 'file'
  path: string
  content: string
  /** Code fence language for the dry-run rendering. */
  lang: string
  describe: string
}

export interface ActionContext {
  octokit: Octokit
  org: string
  repo: string
  /** The hygiene PR opened this run, or `null`. */
  pr: GitHub.PullRequest | null
  /** Final content of every path the PR committed. */
  files: Record<string, string>
  log: Logger
}

/**
 * `undefined` or a string means the fix was applied, the string being the
 * detail. `{ fixed: false }` means nothing broke but the fix could
 * not be applied.
 */
export type ActionResult = string | { fixed: false; detail: string } | undefined

/** Something performed directly against GitHub. */
export interface ActionFix {
  kind: 'action'
  /** Needs the hygiene PR; runs after it is opened and receives it. */
  afterPr?: boolean
  describe: string
  run: (ctx: ActionContext) => Promise<ActionResult>
}

export type Fix = FileFix | ActionFix

/** One thing a check found. */
export interface Finding {
  repo: string
  /** Name of the check that produced it; absent for runner findings. */
  check?: string
  level: Level
  summary: string
  url?: string
  details?: Array<string>
  /** Suggested reviewers for the hygiene PR. */
  reviewers?: Array<string>
  fix?: Fix
  outcome?: Outcome
}

/** What a check returns: a finding before the runner stamps `repo` and `check`. */
export type CheckFinding = Omit<Finding, 'repo' | 'check' | 'outcome'>

/** The only thing a check receives; see `takeSnapshot`. */
export interface Snapshot {
  org: string
  repo: string
  defaultBranch: string
  headSha: string
  listPaths: () => Promise<Array<string>>
  readFile: (path: string) => Promise<FileContent | null>
  readFirstExistingFile: (
    pathCandidates: Array<string>
  ) => Promise<FileContent | null>
  readFileOnDefaultBranch: (path: string) => Promise<FileContent | null>
  listOpenPrs: () => Promise<Array<GitHub.PullRequest>>
  octokit: Octokit
  log: Logger
}

export interface Check {
  name: string
  /** May produce file fixes or `afterPr` actions. */
  opensPr?: boolean
  /** Runs once per run before any repo; a throw fails the run. */
  setup?: (octokit: Octokit) => Promise<void>
  run: (snapshot: Snapshot) => Promise<Array<CheckFinding>>
}
