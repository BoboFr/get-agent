export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogEntry {
  level: LogLevel;
  agentName: string;
  message: string;
  timestamp: string;
  data?: any;
}

export interface LoggerConfig {
  /** Minimum level to emit. Default: "info". */
  level?: LogLevel;
  /** Output format. Default: "text". */
  format?: "text" | "json";
  /** Custom transport — overrides format if provided. */
  transport?: (entry: LogEntry) => void;
}

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info:  "\x1b[36m",
  warn:  "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

function defaultTransport(format: "text" | "json"): (entry: LogEntry) => void {
  return (entry) => {
    if (format === "json") {
      console.log(JSON.stringify(entry));
      return;
    }
    const color = COLORS[entry.level];
    const prefix = `${color}[${entry.agentName}]${RESET}`;
    const line = `${prefix} ${entry.message}`;
    if (entry.data !== undefined) {
      entry.level === "error" ? console.error(line, entry.data) : console.log(line, entry.data);
    } else {
      entry.level === "error" ? console.error(line) : console.log(line);
    }
  };
}

export class Logger {
  private minLevel: number;
  private transport: (entry: LogEntry) => void;
  private agentName: string;

  constructor(agentName: string, config: LoggerConfig = {}) {
    this.agentName = agentName;
    this.minLevel = LEVELS[config.level ?? "info"];
    this.transport = config.transport ?? defaultTransport(config.format ?? "text");
  }

  debug(message: string, data?: any): void { this.emit("debug", message, data); }
  info (message: string, data?: any): void { this.emit("info",  message, data); }
  warn (message: string, data?: any): void { this.emit("warn",  message, data); }
  error(message: string, data?: any): void { this.emit("error", message, data); }

  private emit(level: LogLevel, message: string, data?: any): void {
    if (LEVELS[level] < this.minLevel) return;
    const entry: LogEntry = {
      level,
      agentName: this.agentName,
      message,
      timestamp: new Date().toISOString(),
      ...(data !== undefined ? { data } : {}),
    };
    this.transport(entry);
  }
}
