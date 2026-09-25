import type { Octokit } from '../types.ts'

// Handlers and the params they record are whatever a test passes, so
// they are deliberately untyped.

type Params = any
export type Handler = (params: Params) => unknown

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

export function createHttpError(
  status: number,
  message = `HTTP ${status}`
): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

/** A contents API response for a text file. */
export function createFileResponse(
  path: string,
  content: string,
  sha = `sha-${path}`
): { path: string; sha: string; content: string } {
  return { path, sha, content: Buffer.from(content, 'utf8').toString('base64') }
}

/** The params of every recorded call to `name`, in order. */
export function listCallsTo(octokit: FakeOctokit, name: string): Array<Params> {
  return octokit.calls.filter((c) => c.name === name).map((c) => c.params)
}
