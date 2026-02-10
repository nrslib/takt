/**
 * Tests for debug logging utilities
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initDebugLogger,
  resetDebugLogger,
  createLogger,
  isDebugEnabled,
  getDebugLogFile,
  setVerboseConsole,
  isVerboseConsole,
  debugLog,
  infoLog,
  errorLog,
  writePromptLog,
} from '../shared/utils/index.js';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function resolvePromptsLogFilePath(): string {
  const debugLogFile = getDebugLogFile();
  expect(debugLogFile).not.toBeNull();
  if (!debugLogFile!.endsWith('.log')) {
    throw new Error(`unexpected debug log file path: ${debugLogFile!}`);
  }
  return debugLogFile!.replace(/\.log$/, '-prompts.jsonl');
}

describe('debug logging', () => {
  beforeEach(() => {
    resetDebugLogger();
  });

  afterEach(() => {
    resetDebugLogger();
  });

  describe('initDebugLogger', () => {
    it('should not enable debug when config is undefined', () => {
      initDebugLogger(undefined, '/tmp');
      expect(isDebugEnabled()).toBe(false);
      expect(getDebugLogFile()).toBeNull();
    });

    it('should not enable debug when enabled is false', () => {
      initDebugLogger({ enabled: false }, '/tmp');
      expect(isDebugEnabled()).toBe(false);
    });

    it('should enable debug when enabled is true', () => {
      const projectDir = join(tmpdir(), 'takt-test-debug-enable-' + Date.now());
      mkdirSync(projectDir, { recursive: true });

      try {
        initDebugLogger({ enabled: true }, projectDir);
        expect(isDebugEnabled()).toBe(true);
        expect(getDebugLogFile()).not.toBeNull();
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it('should write debug log to project .takt/runs/*/logs/ directory', () => {
      const projectDir = join(tmpdir(), 'takt-test-debug-project-' + Date.now());
      mkdirSync(projectDir, { recursive: true });

      try {
        initDebugLogger({ enabled: true }, projectDir);
        const logFile = getDebugLogFile();
        expect(logFile).not.toBeNull();
        expect(logFile!).toContain(join(projectDir, '.takt', 'runs'));
        expect(logFile!).toContain(`${join(projectDir, '.takt', 'runs')}/`);
        expect(logFile!).toContain('/logs/');
        expect(logFile!).toMatch(/debug-.*\.log$/);
        expect(existsSync(logFile!)).toBe(true);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it('should create prompts log file with -prompts suffix', () => {
      const projectDir = join(tmpdir(), 'takt-test-debug-prompts-' + Date.now());
      mkdirSync(projectDir, { recursive: true });

      try {
        initDebugLogger({ enabled: true }, projectDir);
        const promptsLogFile = resolvePromptsLogFilePath();
        expect(promptsLogFile).toContain(join(projectDir, '.takt', 'runs'));
        expect(promptsLogFile).toContain('/logs/');
        expect(promptsLogFile).toMatch(/debug-.*-prompts\.jsonl$/);
        expect(existsSync(promptsLogFile)).toBe(true);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it('should not create log file when projectDir is not provided', () => {
      initDebugLogger({ enabled: true });
      expect(isDebugEnabled()).toBe(true);
      expect(getDebugLogFile()).toBeNull();
    });

    it('should use custom log file when provided', () => {
      const logDir = join(tmpdir(), 'takt-test-debug-' + Date.now());
      mkdirSync(logDir, { recursive: true });
      const logFile = join(logDir, 'test.log');

      try {
        initDebugLogger({ enabled: true, logFile }, '/tmp');
        expect(getDebugLogFile()).toBe(logFile);
        expect(resolvePromptsLogFilePath()).toBe(join(logDir, 'test-prompts.jsonl'));
        expect(existsSync(logFile)).toBe(true);
        expect(existsSync(join(logDir, 'test-prompts.jsonl'))).toBe(true);

        const content = readFileSync(logFile, 'utf-8');
        expect(content).toContain('TAKT Debug Log');
      } finally {
        rmSync(logDir, { recursive: true, force: true });
      }
    });

    it('should only initialize once', () => {
      const projectDir = join(tmpdir(), 'takt-test-debug-once-' + Date.now());
      mkdirSync(projectDir, { recursive: true });

      try {
        initDebugLogger({ enabled: true }, projectDir);
        const firstFile = getDebugLogFile();

        initDebugLogger({ enabled: false }, projectDir);
        expect(isDebugEnabled()).toBe(true);
        expect(getDebugLogFile()).toBe(firstFile);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  describe('resetDebugLogger', () => {
    it('should reset all state', () => {
      initDebugLogger({ enabled: true }, '/tmp');
      setVerboseConsole(true);

      resetDebugLogger();

      expect(isDebugEnabled()).toBe(false);
      expect(getDebugLogFile()).toBeNull();
      expect(isVerboseConsole()).toBe(false);
    });
  });

  describe('writePromptLog', () => {
    it('should append prompt log record when debug is enabled', () => {
      const projectDir = join(tmpdir(), 'takt-test-debug-write-prompts-' + Date.now());
      mkdirSync(projectDir, { recursive: true });

      try {
        initDebugLogger({ enabled: true }, projectDir);
        const promptsLogFile = resolvePromptsLogFilePath();

        writePromptLog({
          movement: 'plan',
          phase: 1,
          iteration: 2,
          prompt: 'prompt text',
          response: 'response text',
          timestamp: '2026-02-07T00:00:00.000Z',
        });

        const content = readFileSync(promptsLogFile, 'utf-8').trim();
        expect(content).not.toBe('');
        const parsed = JSON.parse(content) as {
          movement: string;
          phase: number;
          iteration: number;
          prompt: string;
          response: string;
          timestamp: string;
        };
        expect(parsed.movement).toBe('plan');
        expect(parsed.phase).toBe(1);
        expect(parsed.iteration).toBe(2);
        expect(parsed.prompt).toBe('prompt text');
        expect(parsed.response).toBe('response text');
        expect(parsed.timestamp).toBe('2026-02-07T00:00:00.000Z');
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it('should do nothing when debug is disabled', () => {
      writePromptLog({
        movement: 'plan',
        phase: 1,
        iteration: 1,
        prompt: 'ignored prompt',
        response: 'ignored response',
        timestamp: '2026-02-07T00:00:00.000Z',
      });

      expect(getDebugLogFile()).toBeNull();
    });
  });

  describe('setVerboseConsole / isVerboseConsole', () => {
    it('should default to false', () => {
      expect(isVerboseConsole()).toBe(false);
    });

    it('should enable verbose console', () => {
      setVerboseConsole(true);
      expect(isVerboseConsole()).toBe(true);
    });

    it('should disable verbose console', () => {
      setVerboseConsole(true);
      setVerboseConsole(false);
      expect(isVerboseConsole()).toBe(false);
    });
  });

  describe('verbose console output', () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it('should not output to stderr when verbose is disabled', () => {
      debugLog('test', 'hello');
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('should output debug to stderr when verbose is enabled', () => {
      setVerboseConsole(true);
      debugLog('test', 'hello debug');

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = stderrSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('[DEBUG]');
      expect(output).toContain('[test]');
      expect(output).toContain('hello debug');
    });

    it('should output info to stderr when verbose is enabled', () => {
      setVerboseConsole(true);
      infoLog('mycomp', 'info message');

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = stderrSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('[INFO]');
      expect(output).toContain('[mycomp]');
      expect(output).toContain('info message');
    });

    it('should output error to stderr when verbose is enabled', () => {
      setVerboseConsole(true);
      errorLog('mycomp', 'error message');

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = stderrSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('[ERROR]');
      expect(output).toContain('[mycomp]');
      expect(output).toContain('error message');
    });

    it('should include timestamp in console output', () => {
      setVerboseConsole(true);
      debugLog('test', 'with timestamp');

      const output = stderrSpy.mock.calls[0]?.[0] as string;
      // Timestamp format: HH:mm:ss.SSS
      expect(output).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/);
    });
  });

  describe('createLogger', () => {
    it('should create a logger with the given component name', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      setVerboseConsole(true);

      const log = createLogger('my-component');
      log.debug('test message');

      const output = stderrSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('[my-component]');

      stderrSpy.mockRestore();
    });

    it('should provide debug, info, error, enter, exit methods', () => {
      const log = createLogger('test');
      expect(typeof log.debug).toBe('function');
      expect(typeof log.info).toBe('function');
      expect(typeof log.error).toBe('function');
      expect(typeof log.enter).toBe('function');
      expect(typeof log.exit).toBe('function');
    });
  });

  describe('file logging with verbose console', () => {
    it('should write to both file and stderr when both are enabled', () => {
      const logDir = join(tmpdir(), 'takt-test-debug-both-' + Date.now());
      mkdirSync(logDir, { recursive: true });
      const logFile = join(logDir, 'test.log');

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      try {
        initDebugLogger({ enabled: true, logFile }, '/tmp');
        setVerboseConsole(true);

        debugLog('test', 'dual output');

        // Check stderr
        expect(stderrSpy).toHaveBeenCalledTimes(1);
        const stderrOutput = stderrSpy.mock.calls[0]?.[0] as string;
        expect(stderrOutput).toContain('dual output');

        // Check file
        const fileContent = readFileSync(logFile, 'utf-8');
        expect(fileContent).toContain('dual output');
      } finally {
        stderrSpy.mockRestore();
        rmSync(logDir, { recursive: true, force: true });
      }
    });

    it('should output to stderr even when file logging is disabled', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      try {
        // File logging not enabled, but verbose console is
        setVerboseConsole(true);
        debugLog('test', 'console only');

        expect(stderrSpy).toHaveBeenCalledTimes(1);
        const output = stderrSpy.mock.calls[0]?.[0] as string;
        expect(output).toContain('console only');
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});
