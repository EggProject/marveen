import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
})

/**
 * Structural signature matching pino's logger methods. Declared as overloads
 * so both `logger.info('msg')` and `logger.info({ ctx: 'value' }, 'msg')`
 * compile. Compatible with `pino.Logger` (see h-cross-cutting/04:132-137).
 */
export interface LogFn {
  (msg: string): void
  (obj: object, msg?: string): void
}

/**
 * Structural logger interface. The real `logger` export above satisfies this;
 * tests inject narrower implementations (e.g. noopLog) that must still provide
 * info/warn/error/debug. Required by Phase 1 per
 * docs/refactor-to-classbase/h-cross-cutting/04:18-69 (rejects bare pino alias
 * which would invalidate 91 vi.mock('../logger.js') fixtures).
 */
export interface LoggerLike {
  readonly info: LogFn
  readonly warn: LogFn
  readonly error: LogFn
  readonly debug: LogFn
}
