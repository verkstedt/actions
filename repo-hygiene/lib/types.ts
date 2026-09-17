import type { getOctokit } from '@actions/github'
import type { Document, YAMLMap } from 'yaml'

export type Octokit = ReturnType<typeof getOctokit>

/** Workflow log output; see `createLogger`. */
export interface Logger {
  info: (message: string) => void
  warning: (message: string) => void
  error: (message: string) => void
}

/** A text file fetched through the contents API. */
export interface FileContent {
  sha: string
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

export interface MissingCodeownersLine {
  pattern: string
  lineNumber: number
  ownerToken: string
}

export interface CodeownersChange extends Change {
  missingLines: Array<MissingCodeownersLine>
  addedLines: Array<string>
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

/** What is shared across all repos of one run. */
export interface RunContext {
  octokit: Octokit
  org: string
  dryRun: boolean
  template: DependabotTemplate
  runId: number
  runAttempt: number
}

/** `RunContext` plus what is known about the repo being audited. */
export interface RepoContext extends RunContext {
  log: Logger
  repo: string
  repoSlug: string
  defaultBranch: string
}

export type Result =
  | { repo: string; action: 'ok' }
  | { repo: string; action: 'failed'; error: string }
  | {
      repo: string
      action: 'skipped-existing-pr'
      prUrl: string
      reviewers: Array<string>
    }
  | {
      repo: string
      action: 'dry-run'
      reviewers: Array<string>
      unresolvedOwner: boolean
    }
  | {
      repo: string
      action: 'opened-pr'
      prUrl: string
      reviewers: Array<string>
    }

export type ResultOf<A extends Result['action']> = Extract<
  Result,
  { action: A }
>
