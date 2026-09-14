// Shared helpers for the tests in this directory. Not a test file
// itself, so its name must not match node’s default test patterns.

/**
 * A logger stand-in that records instead of printing. What would have
 * been logged is in `calls`, keyed by level.
 */
export function fakeLog() {
  const calls = { info: [], warning: [], error: [] }
  return {
    calls,
    info: (message) => calls.info.push(message),
    warning: (message) => calls.warning.push(message),
    error: (message) => calls.error.push(message),
  }
}

/**
 * An octokit stand-in built from `handlers`, keyed like
 * `'pulls.list'`. Each handler receives the request params and
 * returns the response `data`; throw to simulate an API error. Every
 * call is recorded in `calls` as `{ name, params }`. `paginate`
 * returns the handler’s data as-is.
 */
export function fakeOctokit(handlers) {
  const calls = []
  const rest = {}
  for (const [name, handler] of Object.entries(handlers)) {
    const [ns, method] = name.split('.')
    rest[ns] ??= {}
    rest[ns][method] = async (params) => {
      calls.push({ name, params })
      return { data: await handler(params) }
    }
  }
  return {
    rest,
    calls,
    paginate: async (fn, params) => (await fn(params)).data,
    request: async (route, params) => {
      calls.push({ name: route, params })
      return { data: await handlers[route](params) }
    },
  }
}

export function httpError(status, message = `HTTP ${status}`) {
  const e = new Error(message)
  e.status = status
  return e
}

/** A contents API response for a text file. */
export function fileResponse(path, content, sha = `sha-${path}`) {
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
