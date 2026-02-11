/**
 * Structured JSON logger for serverless observability.
 * Each log entry includes requestId and optional recordId for tracing.
 */

export interface LogContext {
  requestId: string;
  recordId?: string;
}

type LogLevel = "info" | "warn" | "error" | "debug";

function emit(
  level: LogLevel,
  ctx: LogContext,
  message: string,
  extra?: Record<string, unknown>
): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    requestId: ctx.requestId,
    message,
  };
  if (ctx.recordId) entry.recordId = ctx.recordId;
  if (extra) Object.assign(entry, extra);

  // Vercel captures stdout/stderr as structured logs
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(entry));
}

export function createLogger(ctx: LogContext) {
  return {
    info: (msg: string, extra?: Record<string, unknown>) =>
      emit("info", ctx, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) =>
      emit("warn", ctx, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) =>
      emit("error", ctx, msg, extra),
    debug: (msg: string, extra?: Record<string, unknown>) =>
      emit("debug", ctx, msg, extra),
    child: (overrides: Partial<LogContext>) =>
      createLogger({ ...ctx, ...overrides }),
  };
}

export type Logger = ReturnType<typeof createLogger>;
