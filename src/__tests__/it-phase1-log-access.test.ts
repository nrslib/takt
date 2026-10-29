import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executePhase1LogRequest,
  parsePhase1LogRequest,
  PHASE1_LOG_MAX_RESPONSE_BYTES,
  PHASE1_LOG_MAX_SEARCH_MATCHES,
} from '../core/workflow/phase1-log-access.js';
import {
  Phase1ExecutionLog,
  savePhase1ExecutionLog,
  type Phase1ExecutionLogReference,
} from '../core/workflow/phase1-execution-log.js';
import { ReportInstructionBuilder } from '../core/workflow/instruction/ReportInstructionBuilder.js';

function envelope(value: unknown): string {
  return JSON.stringify({ _takt_phase1_log_request: value });
}

describe('Phase 1 log request protocol and bounded file access', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'takt-phase1-log-access-'));
  });

  afterEach(() => {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  });

  function reference(content: string): Phase1ExecutionLogReference {
    const path = join(directory, 'record.json');
    writeFileSync(path, content);
    return { path, byteSize: Buffer.byteLength(content), stepName: 'review', stepIteration: 1 };
  }

  it.each([
    envelope({ operation: 'read', offset: 0, limit: 10, path: '/other' }),
    envelope({ operation: 'search', offset: 0, limit: 10 }),
    envelope({ operation: 'search', offset: -1, limit: 10, query: 'x' }),
    envelope({ operation: 'read', offset: 0, limit: PHASE1_LOG_MAX_RESPONSE_BYTES + 1 }),
    envelope({ operation: 'command', offset: 0, limit: 10 }),
    '{"_takt_phase1_log_request":',
  ])('rejects a malformed or unauthorized reserved request: %s', (content) => {
    expect(parsePhase1LogRequest(content).kind).toBe('invalid');
  });

  it('does not interpret an ordinary final report as a log request', () => {
    expect(parsePhase1LogRequest('# Report\nordinary text').kind).toBe('none');
    expect(parsePhase1LogRequest('{"status":"ok"}').kind).toBe('none');
  });

  it('persists separate masked records and keeps a multi-megabyte body out of the Phase 2 prompt', async () => {
    const largeOutput = 'x'.repeat(2 * 1024 * 1024);
    const log = new Phase1ExecutionLog();
    log.recordEvent({ type: 'tool_output', data: { id: 'large', tool: 'Read', output: largeOutput } });
    log.recordResult({ status: 'done', content: 'password=synthetic-secret-123' });
    const first = await savePhase1ExecutionLog(log, directory, 'review/part', 3);
    const second = await savePhase1ExecutionLog(log, directory, 'review/part', 3);

    expect(first.path).not.toBe(second.path);
    expect(first.path).toContain('review_part-3-');
    const saved = readFileSync(first.path, 'utf8');
    expect(saved).toContain(largeOutput);
    expect(saved).not.toContain('synthetic-secret-123');

    const prompt = new ReportInstructionBuilder({
      name: 'review', persona: 'reviewer', personaDisplayName: 'Reviewer', instruction: 'Review', outputContracts: [{ name: 'review.md', format: '# Report' }],
    }, {
      cwd: directory,
      reportDir: join(directory, 'reports'),
      stepIteration: 3,
      targetFile: 'review.md',
      lastResponse: 'summary',
      phase1ExecutionLog: first,
    }).build();
    expect(prompt).toContain(first.path);
    expect(prompt).not.toContain(largeOutput);
    expect(prompt.length).toBeLessThan(20_000);
  });

  it('reads bounded ranges from one giant JSON entry without splitting returned UTF-8', async () => {
    const record = reference(`[{"kind":"provider_event","event":{"type":"tool_output","data":{"output":"${'あ'.repeat(1024)}${'x'.repeat(2 * 1024 * 1024)}"}}}]`);
    const first = await executePhase1LogRequest(record, { operation: 'read', offset: 0, limit: 256 }, 256);
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(256);
    expect(first.content).not.toContain('�');
    expect(first.nextOffset).not.toBeNull();

    const second = await executePhase1LogRequest(record, { operation: 'read', offset: first.nextOffset!, limit: 128 }, 128);
    expect(Buffer.byteLength(second.content)).toBeLessThanOrEqual(128);
    expect(second.content).not.toContain('�');
    expect(second.nextOffset).toBeGreaterThan(first.nextOffset!);
  });

  it('searches a fixed string across chunk boundaries with count and byte limits', async () => {
    const content = `${'x'.repeat(65_530)}needle${'y'.repeat(2 * 1024 * 1024)}`;
    const record = reference(content);
    const result = await executePhase1LogRequest(record, {
      operation: 'search', offset: 0, limit: 128, query: 'needle',
    }, 128);
    expect(result.matchCount).toBe(1);
    expect(result.content).toContain('@@ 65530');
    expect(result.content).toContain('needle');
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(128);

    const manyContent = Array.from({ length: 30 }, () => 'needle').join('x');
    const manyPath = join(directory, 'many.json');
    writeFileSync(manyPath, manyContent);
    const many = { path: manyPath, byteSize: Buffer.byteLength(manyContent), stepName: 'review', stepIteration: 1 };
    const capped = await executePhase1LogRequest(many, {
      operation: 'search', offset: 0, limit: 1024, query: 'needle',
    }, 1024);
    expect(capped.matchCount).toBe(PHASE1_LOG_MAX_SEARCH_MATCHES);
    expect(capped.truncated).toBe(true);
    expect(capped.nextOffset).not.toBeNull();

    const tiny = await executePhase1LogRequest(record, {
      operation: 'search', offset: 0, limit: 8, query: 'needle',
    }, 8);
    expect(Buffer.byteLength(tiny.content)).toBeLessThanOrEqual(8);
    expect(tiny.nextOffset).toBe(65_536);
  });

  it('rejects a file that no longer matches the engine-saved reference', async () => {
    const record = reference('original');
    appendFileSync(record.path, 'changed');
    await expect(executePhase1LogRequest(record, { operation: 'read', offset: 0, limit: 4 }, 4))
      .rejects.toThrow('not the regular file');
  });
});
