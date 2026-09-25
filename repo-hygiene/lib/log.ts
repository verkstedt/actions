import type {
  LogContext,
  LogEntry,
  Logger,
  LogLevel,
  LogSink,
} from './types.ts'

/** `1/3. repo, check`, or as much of it as the context has. */
export function formatLogPrefix({ repo, check }: LogContext): string {
  const parts = [
    repo ? `${repo.position}/${repo.total}. ${repo.name}` : undefined,
    check,
  ]
  return parts.filter(Boolean).join(', ')
}

/** `prefix: message`, or the bare message without context. */
export function formatLogLine(entry: LogEntry): string {
  const prefix = formatLogPrefix(entry)
  return prefix ? `${prefix}: ${entry.message}` : entry.message
}

/** A logger that remembers its context and the sink it feeds. */
interface ContextLogger extends Logger {
  context: LogContext
  sink: LogSink
}

function isContextLogger(log: Logger): log is ContextLogger {
  return 'context' in log && 'sink' in log
}

/** A plain logger, such as the recording one in tests, as a sink. */
function sinkFor(base: Logger): LogSink {
  return (entry) => base[entry.level](formatLogLine(entry))
}

/**
 * A logger whose entries carry `context`. Built from a sink, it feeds
 * that sink; built from another logger, it adds to that logger’s
 * context and feeds the same sink. A plain logger as `base` receives
 * formatted lines instead.
 */
export function createLogger(
  context: LogContext,
  base: LogSink | Logger
): Logger {
  let sink: LogSink
  let merged = context
  if (typeof base === 'function') {
    sink = base
  } else if (isContextLogger(base)) {
    sink = base.sink
    merged = { ...base.context, ...context }
  } else {
    sink = sinkFor(base)
  }
  const log = (level: LogLevel) => (message: string) =>
    sink({ ...merged, level, message })
  const logger: ContextLogger = {
    context: merged,
    sink,
    info: log('info'),
    warning: log('warning'),
    error: log('error'),
  }
  return logger
}
