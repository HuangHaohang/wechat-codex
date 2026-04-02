type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = (process.env.WECHAT_CODEX_LOG_LEVEL as LogLevel) || "info";

const SCOPE_LABELS: Record<string, string> = {
  cli: "cli",
  gateway: "网关",
  weixin: "weixin",
  mcp: "mcp",
  media: "media",
  codex: "codex",
  "openai-provider": "openai-compat",
};

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

export function createLogger(scope: string) {
  const log = (level: LogLevel, message: string) => {
    if (!shouldLog(level)) return;
    const prefix = `${formatTimestamp(new Date())} ${level.toUpperCase()} [${SCOPE_LABELS[scope] || scope}]`;
    console.log(`${prefix} ${message}`);
  };

  return {
    debug: (message: string) => log("debug", message),
    info: (message: string) => log("info", message),
    warn: (message: string) => log("warn", message),
    error: (message: string) => log("error", message),
  };
}

function formatTimestamp(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}
