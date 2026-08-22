export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  constructor(private readonly minLevel: LogLevel) {}

  log(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }
    process.stderr.write(`[${level}] ${message}\n`);
  }

  debug(message: string): void {
    this.log('debug', message);
  }

  error(message: string): void {
    this.log('error', message);
  }
}
