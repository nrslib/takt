import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callMock } from '../infra/mock/client.js';
import { resetScenario } from '../infra/mock/scenario.js';

interface MockCallRecord {
  readonly event: 'start' | 'complete';
  readonly provider: 'mock';
  readonly personaName: string;
  readonly model?: string;
  readonly status?: string;
  readonly aborted?: boolean;
  readonly sessionId?: string;
}

const temporaryDirectories: string[] = [];
const itPosix = process.platform === 'win32' ? it.skip : it;

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'takt-mock-call-log-'));
  temporaryDirectories.push(directory);
  return directory;
}

function readRecords(path: string): MockCallRecord[] {
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as MockCallRecord);
}

afterEach(() => {
  resetScenario();
  delete process.env.TAKT_MOCK_CALL_LOG;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('mock call log private artifact contract', () => {
  itPosix('should create a 0600 log without recording session IDs', async () => {
    const directory = createTemporaryDirectory();
    const logPath = join(directory, 'calls.jsonl');
    process.env.TAKT_MOCK_CALL_LOG = logPath;

    const sensitivePrompt = [
      'TASK_SECRET_MARKER',
      'REPORT_SECRET_MARKER',
      'DIFF_SECRET_MARKER',
    ].join('\n');
    await callMock('selector', sensitivePrompt, {
      cwd: directory,
      model: 'mock-selector-model',
      sessionId: 'sensitive-session-id',
    });

    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    const records = readRecords(logPath);
    expect(records).toEqual([
      expect.objectContaining({
        event: 'start',
        provider: 'mock',
        personaName: 'selector',
        model: 'mock-selector-model',
      }),
      expect.objectContaining({
        event: 'complete',
        provider: 'mock',
        personaName: 'selector',
        status: 'done',
        aborted: false,
      }),
    ]);
    expect(records.every((record) => record.sessionId === undefined)).toBe(true);
    const rawLog = readFileSync(logPath, 'utf-8');
    expect(rawLog).not.toContain('sensitive-session-id');
    expect(rawLog).not.toContain('TASK_SECRET_MARKER');
    expect(rawLog).not.toContain('REPORT_SECRET_MARKER');
    expect(rawLog).not.toContain('DIFF_SECRET_MARKER');
  });

  itPosix('should repair an existing log to 0600 before appending', async () => {
    const directory = createTemporaryDirectory();
    const logPath = join(directory, 'calls.jsonl');
    writeFileSync(logPath, '{"existing":true}\n', { mode: 0o644 });
    chmodSync(logPath, 0o644);
    process.env.TAKT_MOCK_CALL_LOG = logPath;

    await callMock('coder', 'prompt', { cwd: directory, model: 'mock-model' });

    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(logPath, 'utf-8')).toContain('{"existing":true}');
    expect(readFileSync(logPath, 'utf-8')).not.toContain('"prompt"');
  });

  itPosix('should reject a symlink log without changing its target', async () => {
    const directory = createTemporaryDirectory();
    const targetPath = join(directory, 'outside.log');
    const logPath = join(directory, 'calls.jsonl');
    writeFileSync(targetPath, 'unchanged\n');
    symlinkSync(targetPath, logPath);
    process.env.TAKT_MOCK_CALL_LOG = logPath;

    await expect(callMock('selector', 'prompt', { cwd: directory })).rejects.toThrow(/symlink/);

    expect(readFileSync(targetPath, 'utf-8')).toBe('unchanged\n');
  });

  it('should propagate an unsafe log path write failure', async () => {
    const directory = createTemporaryDirectory();
    const logPath = join(directory, 'calls.jsonl');
    mkdirSync(logPath);
    process.env.TAKT_MOCK_CALL_LOG = logPath;

    await expect(callMock('selector', 'prompt', { cwd: directory })).rejects.toThrow();
  });
});
