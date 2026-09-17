import type { Logger } from '../types.ts'

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
