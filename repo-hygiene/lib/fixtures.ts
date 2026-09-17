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
