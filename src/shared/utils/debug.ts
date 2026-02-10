/**
 * Debug logging utilities for takt
 * Writes debug logs to file when enabled in config.
 * When verbose console is enabled, also outputs to stderr.
 */

import { existsSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PromptLogRecord } from './types.js';
/** Debug configuration (duplicated from core/models to avoid shared → core dependency) */
interface DebugConfig {
  enabled: boolean;
  logFile?: string;
}

/**
 * Debug logger singleton.
 * Manages file-based debug logging and verbose console output.
 */
export class DebugLogger {
  private static instance: DebugLogger | null = null;

  private debugEnabled = false;
  private debugLogFile: string | null = null;
  private debugPromptsLogFile: string | null = null;
  private initialized = false;
  private verboseConsoleEnabled = false;

  private constructor() {}

  static getInstance(): DebugLogger {
    if (!DebugLogger.instance) {
      DebugLogger.instance = new DebugLogger();
    }
    return DebugLogger.instance;
  }

  /** Reset singleton for testing */
  static resetInstance(): void {
    DebugLogger.instance = null;
  }

  /** Get default debug log file prefix */
  private static getDefaultLogPrefix(projectDir: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const runSlug = `debug-${timestamp}`;
    return join(projectDir, '.takt', 'runs', runSlug, 'logs', runSlug);
  }

  /** Initialize debug logger from config */
  init(config?: DebugConfig, projectDir?: string): void {
    if (this.initialized) {
      return;
    }

    this.debugEnabled = config?.enabled ?? false;

    if (this.debugEnabled) {
      if (config?.logFile) {
        this.debugLogFile = config.logFile;
        if (config.logFile.endsWith('.log')) {
          this.debugPromptsLogFile = config.logFile.slice(0, -4) + '-prompts.jsonl';
        } else {
          this.debugPromptsLogFile = `${config.logFile}-prompts.jsonl`;
        }
      } else if (projectDir) {
        const logPrefix = DebugLogger.getDefaultLogPrefix(projectDir);
        this.debugLogFile = `${logPrefix}.log`;
        this.debugPromptsLogFile = `${logPrefix}-prompts.jsonl`;
      }

      if (this.debugLogFile) {
        const logDir = dirname(this.debugLogFile);
        if (!existsSync(logDir)) {
          mkdirSync(logDir, { recursive: true });
        }

        const header = [
          '='.repeat(60),
          `TAKT Debug Log`,
          `Started: ${new Date().toISOString()}`,
          `Project: ${projectDir || 'N/A'}`,
          '='.repeat(60),
          '',
        ].join('\n');

        writeFileSync(this.debugLogFile, header, 'utf-8');
      }

      if (this.debugPromptsLogFile) {
        const promptsLogDir = dirname(this.debugPromptsLogFile);
        if (!existsSync(promptsLogDir)) {
          mkdirSync(promptsLogDir, { recursive: true });
        }
        writeFileSync(this.debugPromptsLogFile, '', 'utf-8');
      }
    }

    this.initialized = true;
  }

  /** Reset state (for testing) */
  reset(): void {
    this.debugEnabled = false;
    this.debugLogFile = null;
    this.debugPromptsLogFile = null;
    this.initialized = false;
    this.verboseConsoleEnabled = false;
  }

  /** Enable or disable verbose console output */
  setVerboseConsole(enabled: boolean): void {
    this.verboseConsoleEnabled = enabled;
  }

  /** Check if verbose console is enabled */
  isVerboseConsole(): boolean {
    return this.verboseConsoleEnabled;
  }

  /** Check if debug is enabled */
  isEnabled(): boolean {
    return this.debugEnabled;
  }

  /** Get current debug log file path */
  getLogFile(): string | null {
    return this.debugLogFile;
  }

  /** Format log message with timestamp and level */
  private static formatLogMessage(level: string, component: string, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${component}]`;

    let logLine = `${prefix} ${message}`;

    if (data !== undefined) {
      try {
        const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        logLine += `\n${dataStr}`;
      } catch {
        logLine += `\n[Unable to serialize data]`;
      }
    }

    return logLine;
  }

  /** Format a compact console log line */
  private static formatConsoleMessage(level: string, component: string, message: string): string {
    const timestamp = new Date().toISOString().slice(11, 23);
    return `[${timestamp}] [${level}] [${component}] ${message}`;
  }

  /** Write a log entry to verbose console (stderr) and/or file */
  writeLog(level: string, component: string, message: string, data?: unknown): void {
    if (this.verboseConsoleEnabled) {
      process.stderr.write(DebugLogger.formatConsoleMessage(level, component, message) + '\n');
    }

    if (!this.debugEnabled || !this.debugLogFile) {
      return;
    }

    const logLine = DebugLogger.formatLogMessage(level, component, message, data);

    try {
      appendFileSync(this.debugLogFile, logLine + '\n', 'utf-8');
    } catch {
      // Silently fail - logging errors should not interrupt main flow
    }
  }

  /** Write a prompt/response debug log entry */
  writePromptLog(record: PromptLogRecord): void {
    if (!this.debugEnabled || !this.debugPromptsLogFile) {
      return;
    }

    try {
      appendFileSync(this.debugPromptsLogFile, JSON.stringify(record) + '\n', 'utf-8');
    } catch {
      // Silently fail - logging errors should not interrupt main flow
    }
  }

  /** Create a scoped logger for a component */
  createLogger(component: string) {
    return {
      debug: (message: string, data?: unknown) => this.writeLog('DEBUG', component, message, data),
      info: (message: string, data?: unknown) => this.writeLog('INFO', component, message, data),
      error: (message: string, data?: unknown) => this.writeLog('ERROR', component, message, data),
      enter: (funcName: string, args?: Record<string, unknown>) => this.writeLog('DEBUG', component, `>> ${funcName}()`, args),
      exit: (funcName: string, result?: unknown) => this.writeLog('DEBUG', component, `<< ${funcName}()`, result),
    };
  }
}

// ---- Module-level functions ----

export function initDebugLogger(config?: DebugConfig, projectDir?: string): void {
  DebugLogger.getInstance().init(config, projectDir);
}

export function resetDebugLogger(): void {
  DebugLogger.getInstance().reset();
}

export function setVerboseConsole(enabled: boolean): void {
  DebugLogger.getInstance().setVerboseConsole(enabled);
}

export function isVerboseConsole(): boolean {
  return DebugLogger.getInstance().isVerboseConsole();
}

export function isDebugEnabled(): boolean {
  return DebugLogger.getInstance().isEnabled();
}

export function getDebugLogFile(): string | null {
  return DebugLogger.getInstance().getLogFile();
}

export function debugLog(component: string, message: string, data?: unknown): void {
  DebugLogger.getInstance().writeLog('DEBUG', component, message, data);
}

export function infoLog(component: string, message: string, data?: unknown): void {
  DebugLogger.getInstance().writeLog('INFO', component, message, data);
}

export function errorLog(component: string, message: string, data?: unknown): void {
  DebugLogger.getInstance().writeLog('ERROR', component, message, data);
}

export function writePromptLog(record: PromptLogRecord): void {
  DebugLogger.getInstance().writePromptLog(record);
}

export function traceEnter(component: string, funcName: string, args?: Record<string, unknown>): void {
  debugLog(component, `>> ${funcName}()`, args);
}

export function traceExit(component: string, funcName: string, result?: unknown): void {
  debugLog(component, `<< ${funcName}()`, result);
}

export function createLogger(component: string) {
  return DebugLogger.getInstance().createLogger(component);
}
