import * as core from '@actions/core'

import type { Logger } from './types.ts'

/** Logs through the workflow commands GitHub Actions renders. */
export const actionsLogger: Logger = {
  info: (message) => core.info(message),
  warning: (message) => core.warning(message),
  error: (message) => core.error(message),
}

/**
 * A logger prefixing every message with `prefix` before handing it to
 * `base`, so a per-repo logger can be built once and handed down.
 * Tests pass their own recording object instead.
 */
export function createLogger(
  prefix: string,
  base: Logger = actionsLogger
): Logger {
  const withPrefix = (message: string) =>
    prefix ? `${prefix} ${message}` : message
  return {
    info: (message) => base.info(withPrefix(message)),
    warning: (message) => base.warning(withPrefix(message)),
    error: (message) => base.error(withPrefix(message)),
  }
}
