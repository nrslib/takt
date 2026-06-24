import {
  existsSync,
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
import {
  buildDevloopMemory,
  formatDevloopMemoryReport,
} from '../devloopd/memory.js';
import type { TaktRunImportedEvent } from '../devloopd/ledger.js';

const cleanupDirs = new Set<string>();

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-devloopd-memory-'));
  cleanupDirs.add(dir);
  return dir;
}

function writeLedger(repoPath: string, events: TaktRunImportedEvent[]): string {
  const ledgerPath = join(repoPath, '.devloop', 'ledger.jsonl');
  mkdirSync(join(repoPath, '.devloop'), { recursive: true });
  writeFileSync(ledgerPath, events.map((event) => JSON.stringify(event)).join('\n'), 'utf-8');
  return ledgerPath;
}

function event(input: Partial<TaktRunImportedEvent> & { eventId: string; runSlug: string }): TaktRunImportedEvent {
  return {
    version: 1,
    eventId: input.eventId,
    eventType: 'takt_run_imported',
    timestamp: input.timestamp ?? '2026-06-24T00:00:00.000Z',
    repoPath: input.repoPath ?? '/repo',
    issueNumber: input.issueNumber,
    runSlug: input.runSlug,
    taktRunPath: input.taktRunPath ?? `.takt/runs/${input.runSlug}`,
    status: input.status ?? 'completed',
    task: input.task ?? 'Fix docs typo',
    workflow: input.workflow ?? 'subscription-devloop',
    startTime: input.startTime ?? '2026-06-24T00:00:00.000Z',
    endTime: input.endTime,
    artifacts: input.artifacts ?? [
      {
        kind: 'report',
        path: `.takt/runs/${input.runSlug}/reports/report.md`,
        sha256: 'a'.repeat(64),
        bytes: 120,
      },
      {
        kind: 'log',
        path: `.takt/runs/${input.runSlug}/logs/session.jsonl`,
        sha256: 'b'.repeat(64),
        bytes: 1024,
      },
    ],
  };
}

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

describe('devloopd memory', () => {
  it('renders a compact memory snapshot from imported TAKT runs', () => {
    const repoPath = makeTempDir();
    writeLedger(repoPath, [
      event({ eventId: 'evt_1', runSlug: 'run_1', issueNumber: 123, status: 'failed', workflow: 'devloop' }),
      event({
        eventId: 'evt_2',
        runSlug: 'run_2',
        issueNumber: 124,
        status: 'completed',
        task: 'Fix docs with OPENAI_API_KEY=sk-should-not-leak',
        workflow: 'devloop',
      }),
    ]);

    const report = buildDevloopMemory({ repoPath });
    const output = formatDevloopMemoryReport(report);

    expect(report.passed).toBe(true);
    expect(output).toContain('## Status Counts');
    expect(output).toContain('- completed: 1');
    expect(output).toContain('- failed: 1');
    expect(output).toContain('#124 run_2 completed');
    expect(output).toContain('.takt/runs/run_2/reports/report.md');
    expect(output).not.toContain('session.jsonl');
    expect(output).not.toContain('sk-should-not-leak');
  });

  it('writes project memory as owner-only project-local output', () => {
    const repoPath = makeTempDir();
    writeLedger(repoPath, [event({ eventId: 'evt_1', runSlug: 'run_1', issueNumber: 123 })]);

    const report = buildDevloopMemory({ repoPath, write: true });
    const memoryPath = join(repoPath, '.devloop', 'memory.md');

    expect(report.passed).toBe(true);
    expect(report.outputPath).toBe(memoryPath);
    expect(existsSync(memoryPath)).toBe(true);
    expect(readFileSync(memoryPath, 'utf-8')).toContain('# devloopd Memory');
    expect(statSync(memoryPath).mode & 0o777).toBe(0o600);
  });

  it('fails without writing when the output path escapes the repository', () => {
    const repoPath = makeTempDir();
    const outsidePath = join(makeTempDir(), 'memory.md');
    writeLedger(repoPath, [event({ eventId: 'evt_1', runSlug: 'run_1', issueNumber: 123 })]);

    const report = buildDevloopMemory({ repoPath, outputPath: outsidePath, write: true });

    expect(report.passed).toBe(false);
    expect(report.message).toContain('memory output path must stay inside the repository');
    expect(existsSync(outsidePath)).toBe(false);
  });

  it('rejects symlinked memory directories before writing outside the repository', () => {
    const repoPath = makeTempDir();
    const outsideDir = makeTempDir();
    writeFileSync(
      join(repoPath, 'ledger.jsonl'),
      JSON.stringify(event({ eventId: 'evt_1', runSlug: 'run_1', issueNumber: 123 })),
      'utf-8',
    );
    rmSync(join(repoPath, '.devloop'), { recursive: true, force: true });
    symlinkSync(outsideDir, join(repoPath, '.devloop'), 'dir');

    const report = buildDevloopMemory({ repoPath, ledgerPath: 'ledger.jsonl', write: true });

    expect(report.passed).toBe(false);
    expect(report.message).toContain('memory output path must stay inside the repository');
    expect(existsSync(join(outsideDir, 'memory.md'))).toBe(false);
  });

  it('reports empty memory when no ledger events exist', () => {
    const repoPath = makeTempDir();

    const report = buildDevloopMemory({ repoPath });

    expect(report.passed).toBe(false);
    expect(formatDevloopMemoryReport(report)).toContain('No imported TAKT runs found');
  });
});
