type LogLevel = "info" | "warn" | "error";

type LogEntry = {
  fields: Record<string, unknown>;
  level: LogLevel;
  message: string;
  recordedAt: string;
};

export function createLogger(now: () => string = () => new Date().toISOString()) {
  const entries: LogEntry[] = [];

  function record(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> = {}
  ): void {
    entries.push({
      fields,
      level,
      message,
      recordedAt: now()
    });
  }

  return {
    entries(): LogEntry[] {
      return [...entries];
    },
    error(message: string, fields: Record<string, unknown> = {}): void {
      record("error", message, fields);
    },
    info(message: string, fields: Record<string, unknown> = {}): void {
      record("info", message, fields);
    },
    warn(message: string, fields: Record<string, unknown> = {}): void {
      record("warn", message, fields);
    }
  };
}

export type Logger = ReturnType<typeof createLogger>;
