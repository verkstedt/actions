import * as core from '@actions/core'

/**
 * Workflow log output with every message prefixed by `prefix`, so a
 * per-repo logger can be built once and handed down. Tests pass their
 * own recording object instead.
 */
export function createLogger(prefix) {
  const withPrefix = (message) => (prefix ? `${prefix} ${message}` : message)
  return {
    info: (message) => core.info(withPrefix(message)),
    warning: (message) => core.warning(withPrefix(message)),
    error: (message) => core.error(withPrefix(message)),
  }
}
