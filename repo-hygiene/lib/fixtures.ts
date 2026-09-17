// Shared helpers for the tests in this directory. Not a test file
// itself, so its name must not match node’s default test patterns.

import type { Logger, Octokit } from './types.ts'

export interface FakeLog extends Logger {
  calls: Record<'info' | 'warning' | 'error', Array<string>>
}

/**
 * A logger stand-in that records instead of printing. What would have
 * been logged is in `calls`, keyed by level.
 */
export function fakeLog(): FakeLog {
  const calls: FakeLog['calls'] = { info: [], warning: [], error: [] }
  return {
    calls,
    info: (message) => calls.info.push(message),
    warning: (message) => calls.warning.push(message),
    error: (message) => calls.error.push(message),
  }
}

// Handlers and the params they record are whatever a test passes, so
// they are deliberately untyped.

type Params = any
type Handler = (params: Params) => unknown

export interface RecordedCall {
  name: string
  params: Params
}

export type FakeOctokit = Octokit & { calls: Array<RecordedCall> }

/**
 * An octokit stand-in built from `handlers`, keyed like
 * `'pulls.list'`. Each handler receives the request params and
 * returns the response `data`; throw to simulate an API error. Every
 * call is recorded in `calls` as `{ name, params }`. `paginate`
 * returns the handler’s data as-is.
 */
export function fakeOctokit(handlers: Record<string, Handler>): FakeOctokit {
  const calls: Array<RecordedCall> = []
  const rest: Record<string, Record<string, Handler>> = {}
  for (const [name, handler] of Object.entries(handlers)) {
    const [ns, method] = name.split('.')
    rest[ns] ??= {}
    rest[ns][method] = async (params: Params) => {
      calls.push({ name, params })
      return { data: await handler(params) }
    }
  }
  const fake = {
    rest,
    calls,
    paginate: async (fn: Handler, params: Params) =>
      ((await fn(params)) as { data: unknown }).data,
    request: async (route: string, params: Params) => {
      calls.push({ name: route, params })
      return { data: await handlers[route](params) }
    },
  }
  return fake as unknown as FakeOctokit
}

export function httpError(
  status: number,
  message = `HTTP ${status}`
): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

/** A contents API response for a text file. */
export function fileResponse(
  path: string,
  content: string,
  sha = `sha-${path}`
): { path: string; sha: string; content: string } {
  return { path, sha, content: Buffer.from(content, 'utf8').toString('base64') }
}

export interface FakeRepoOptions {
  /** Tree paths without a leading `/`. */
  paths?: Array<string>
  /** Committed files, path → content. */
  files?: Record<string, string>
  openPrs?: Array<unknown>
  contributors?: Array<unknown>
  /** Extra or overriding handlers, keyed like `'pulls.listFiles'`. */
  handlers?: Record<string, Handler>
}

/**
 * An octokit for one repo: the given tree, files and open PRs, one
 * human contributor unless overridden, and PR creation that returns
 * PR 42. `handlers` win over the defaults.
 */
export function fakeRepo({
  paths = [],
  files = {},
  openPrs = [],
  contributors,
  handlers = {},
}: FakeRepoOptions = {}): FakeOctokit {
  return fakeOctokit({
    'pulls.list': () => openPrs,
    'git.getRef': () => ({ object: { sha: 'head' } }),
    'git.getCommit': () => ({ tree: { sha: 'tree' } }),
    'git.getTree': () => ({
      truncated: false,
      tree: paths.map((p) => ({ path: p })),
    }),
    'repos.getContent': ({ path }: { path: string }) => {
      if (path in files) return fileResponse(path, files[path])
      throw httpError(404)
    },
    'repos.listContributors': () =>
      contributors ?? [{ type: 'User', login: 'alice' }],
    'git.createRef': () => ({}),
    'repos.createOrUpdateFileContents': () => ({}),
    'pulls.create': ({ body, head }: { body: string; head: string }) => ({
      number: 42,
      html_url: 'https://p/42',
      head: { sha: 'prhead', ref: head },
      body,
    }),
    'pulls.requestReviewers': () => ({}),
    'pulls.createReview': () => ({}),
    'pulls.listReviews': () => [],
    'pulls.listFiles': () => [],
    ...handlers,
  })
}

/** The params of every recorded call to `name`, in order. */
export function callsTo(octokit: FakeOctokit, name: string): Array<Params> {
  return octokit.calls.filter((c) => c.name === name).map((c) => c.params)
}

export const DEPENDABOT_TEMPLATE = `# Org template
version: 2
updates:
  # JavaScript
  - package-ecosystem: 'npm'
    directory: '/'
    schedule:
      interval: 'weekly'
    cooldown:
      default-days: 7
  - package-ecosystem: 'docker'
    directory: '/'
    schedule:
      interval: 'weekly'
    cooldown:
      default-days: 7
  - package-ecosystem: 'github-actions'
    directory: '/'
    schedule:
      interval: 'weekly'
    cooldown:
      default-days: 7
`
