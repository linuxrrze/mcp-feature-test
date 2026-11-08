/**
 * Minimal structured logger. Everything goes to **stderr**: in stdio mode
 * stdout is the MCP protocol channel and must never carry log output.
 *
 * Env:
 *   LOG_LEVEL  = debug | info (default) | warn | error | silent
 *   LOG_FORMAT = text (default, human readable) | json (one JSON object per line)
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

const LEVELS: Record<LogLevel | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface LogRecord {
    time: string;
    level: LogLevel;
    /** Machine-readable event name, e.g. `client.connected`, `tool.call`. */
    event: string;
    msg: string;
    [key: string]: unknown;
}

export interface LoggerConfig {
    level: LogLevel | 'silent';
    format: LogFormat;
    /** Where formatted lines go. Defaults to process.stderr. */
    write: (line: string) => void;
}

function parseLevel(v: string | undefined): LogLevel | 'silent' {
    const l = (v ?? '').trim().toLowerCase();
    return l in LEVELS ? (l as LogLevel | 'silent') : 'info';
}

function parseFormat(v: string | undefined): LogFormat {
    return (v ?? '').trim().toLowerCase() === 'json' ? 'json' : 'text';
}

const config: LoggerConfig = {
    level: parseLevel(process.env.LOG_LEVEL),
    format: parseFormat(process.env.LOG_FORMAT),
    write: line => process.stderr.write(line)
};

/** Override logger settings (used by tests; env vars cover normal use). */
export function configureLogger(patch: Partial<LoggerConfig>): LoggerConfig {
    const previous = { ...config };
    Object.assign(config, patch);
    return previous;
}

export function isLevelEnabled(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[config.level];
}

/**
 * Emit one log event.
 *
 * `details` is extra text appended below the message in text format only
 * (e.g. a multi-line capability table); `data` fields appear in both formats.
 */
export function log(level: LogLevel, event: string, msg: string, data: Record<string, unknown> = {}, details?: string): void {
    if (!isLevelEnabled(level)) return;
    const time = new Date().toISOString();
    if (config.format === 'json') {
        const record: LogRecord = { time, level, event, msg, ...data };
        config.write(JSON.stringify(record) + '\n');
        return;
    }
    const head = `${time} ${level.toUpperCase().padEnd(5)} [${event}] ${msg}`;
    config.write(details ? `${head}\n${details.replace(/^/gm, '    ')}\n` : `${head}\n`);
}

export const logger = {
    debug: (event: string, msg: string, data?: Record<string, unknown>, details?: string) => log('debug', event, msg, data, details),
    info: (event: string, msg: string, data?: Record<string, unknown>, details?: string) => log('info', event, msg, data, details),
    warn: (event: string, msg: string, data?: Record<string, unknown>, details?: string) => log('warn', event, msg, data, details),
    error: (event: string, msg: string, data?: Record<string, unknown>, details?: string) => log('error', event, msg, data, details)
};

/** Error → loggable plain object. */
export function errorData(e: unknown): Record<string, unknown> {
    return e instanceof Error ? { error: e.message, ...(e.stack && isLevelEnabled('debug') ? { stack: e.stack } : {}) } : { error: String(e) };
}
