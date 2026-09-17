import * as core from '@actions/core'

import type { Logger } from './types.ts'

/**
 * Workflow log output with every message prefixed by `prefix`, so a
 * per-repo logger can be built once and handed down. Tests pass their
 * own recording object instead.
 */
export function createLogger(prefix: string): Logger {
  const withPrefix = (message: string) =>
    prefix ? `${prefix} ${message}` : message
  return {
    info: (message) => core.info(withPrefix(message)),
    warning: (message) => core.warning(withPrefix(message)),
    error: (message) => core.error(withPrefix(message)),
  }
}
