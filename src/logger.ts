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
 * compile. Compatible with `pino.Logger`.
 */
export interface LogFn {
  (msg: string): void
  (obj: object, msg?: string): void
}

/**
 * Structural logger interface. The real `logger` export above satisfies this;
 * tests inject narrower implementations (e.g. noopLog) that must still provide
 * info/warn/error/debug. A bare pino alias would not satisfy this interface,
 * which would invalidate every `vi.mock('../logger.js')` fixture across the
 * test suite.
 */
export interface LoggerLike {
  readonly info: LogFn
  readonly warn: LogFn
  readonly error: LogFn
  readonly debug: LogFn
}
