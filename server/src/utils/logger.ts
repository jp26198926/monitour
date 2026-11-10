export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let threshold: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

function emit(level: LogLevel, tag: string, ...args: unknown[]): void {
  if (LEVELS[level] < LEVELS[threshold]) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase().padEnd(5)}] [${tag}]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(prefix, ...args);
}

export function createLogger(tag: string) {
  return {
    debug: (...args: unknown[]) => emit('debug', tag, ...args),
    info: (...args: unknown[]) => emit('info', tag, ...args),
    warn: (...args: unknown[]) => emit('warn', tag, ...args),
    error: (...args: unknown[]) => emit('error', tag, ...args),
  };
}
