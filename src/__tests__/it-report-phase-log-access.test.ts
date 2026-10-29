import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResponse } from '../core/models/types.js';
import type { Phase1ExecutionLogReference } from '../core/workflow/phase1-execution-log.js';
import {
  generateReportPhase,
  ReportPhaseGenerationError,
  runReportPhase,
  type ReportPhaseRunnerContext,
} from '../core/workflow/phase-runner.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));

import { runAgent } from '../agents/runner.js';

const step = {
  name: 'review',
  persona: 'reviewer',
  personaDisplayName: 'Reviewer',
  instruction: 'Review current work',
  passPreviousResponse: false,
  outputContracts: [{ name: 'review.md', format: '# Report' }],
};

function response(content: string, sessionId?: string): AgentResponse {
  return { persona: 'reviewer', status: 'done', content, sessionId, timestamp: new Date() };
}

function request(offset = 0, limit = 5): string {
  return JSON.stringify({ _takt_phase1_log_request: { operation: 'read', offset, limit } });
}

describe('Phase 2 engine-mediated Phase 1 log access', () => {
  let directory: string;
  let reference: Phase1ExecutionLogReference;

  beforeEach(() => {
    vi.resetAllMocks();
    directory = mkdtempSync(join(tmpdir(), 'takt-report-log-access-'));
    const content = '0123456789abcdefghijklmnopqrstuvwxyz';
    const path = join(directory, 'current-step.json');
    writeFileSync(path, content);
    reference = { path, byteSize: Buffer.byteLength(content), stepName: 'review', stepIteration: 1 };
  });

  afterEach(() => {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  });

  function createContext(sessionId: string | undefined): ReportPhaseRunnerContext {
    const reportDir = join(directory, 'reports');
    return {
      workflowName: 'log-access-test',
      cwd: directory,
      reportDir,
      language: 'en',
      lastResponse: 'Current work summary',
      task: 'Report only verified work',
      phase1ExecutionLog: reference,
      resolveSessionKey: () => 'reviewer',
      getSessionId: () => sessionId,
      buildResumeOptions: (_step, id, overrides) => ({
        cwd: directory, resolvedProvider: 'opencode', sessionId: id, allowedTools: [], maxTurns: overrides.maxTurns,
      }),
      buildNewSessionReportOptions: (_step, overrides) => ({
        cwd: directory, resolvedProvider: 'opencode', allowedTools: overrides.allowedTools, maxTurns: overrides.maxTurns,
      }),
      buildFallbackReportOptions: (_step, _failed, overrides) => ({
        cwd: directory, resolvedProvider: 'claude', allowedTools: overrides.allowedTools, maxTurns: overrides.maxTurns,
      }),
      resolveReportFallbackProviderModel: () => ({ provider: 'claude', model: undefined }),
      resolveStepProviderModel: () => ({ provider: 'opencode', model: undefined }),
      updatePersonaSession: () => {},
    };
  }

  function queue(...responses: AgentResponse[]): void {
    for (const result of responses) {
      vi.mocked(runAgent).mockImplementationOnce(async (persona, instruction, options) => {
        options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
        return result;
      });
    }
  }

  it('executes a resumed-session read against the fixed file before saving the final report', async () => {
    const ctx = createContext('phase1-session');
    queue(response(request(5, 5), 'report-session'), response('# Report\nverified', 'report-session'));

    await runReportPhase(step, 1, ctx);

    const calls = vi.mocked(runAgent).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toContain(reference.path);
    expect(calls[0]?.[1]).not.toContain('0123456789abcdefghijklmnopqrstuvwxyz');
    expect(calls[1]?.[1]).toContain('56789');
    expect(calls[1]?.[1]).toContain('"offset":5');
    expect(calls[1]?.[2]?.sessionId).toBe('report-session');
    expect(calls[1]?.[2]?.allowedTools).toEqual([]);
    expect(readFileSync(join(ctx.reportDir, 'review.md'), 'utf8')).toBe('# Report\nverified');
  });

  it('does not run final output validation for an intermediate log request', async () => {
    const ctx = createContext('phase1-session');
    const validateReportContent = vi.fn(() => ({ valid: true }));
    queue(response(request(0, 3), 'report-session'), response('# Report\nvalidated'));

    await generateReportPhase(step, 1, ctx, { validateReportContent });

    expect(validateReportContent).toHaveBeenCalledOnce();
    expect(validateReportContent).toHaveBeenCalledWith('# Report\nvalidated');
  });

  it('keeps the original context and correlates the result when no session can be resumed', async () => {
    const ctx = createContext(undefined);
    queue(response(request(10, 3)), response('# Report\nnew session verified'));

    await runReportPhase(step, 1, ctx);

    const calls = vi.mocked(runAgent).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1]).toContain('Report only verified work');
    expect(calls[1]?.[1]).toContain('Current work summary');
    expect(calls[1]?.[1]).toContain('abc');
    expect(calls[1]?.[2]?.sessionId).toBeUndefined();
    expect(readFileSync(join(ctx.reportDir, 'review.md'), 'utf8')).not.toContain('_takt_phase1_log_request');
  });

  it('executes a literal search and returns bounded offsets to the model', async () => {
    const ctx = createContext('phase1-session');
    const search = JSON.stringify({ _takt_phase1_log_request: {
      operation: 'search', offset: 0, limit: 64, query: 'cdef',
    } });
    queue(response(search, 'report-session'), response('# Report\nsearch verified'));

    await runReportPhase(step, 1, ctx);

    expect(vi.mocked(runAgent).mock.calls[1]?.[1]).toContain('@@ 12');
    expect(vi.mocked(runAgent).mock.calls[1]?.[1]).toContain('"matchCount":1');
  });

  it('uses the same record through retry and fallback attempts', async () => {
    const ctx = createContext('phase1-session');
    queue(
      response('', 'failed-primary'),
      response('', 'failed-retry'),
      response(request(26, 4), 'fallback-session'),
      response('# Report\nfallback verified'),
    );

    await runReportPhase(step, 1, ctx);

    const calls = vi.mocked(runAgent).mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0]?.[1]).toContain(reference.path);
    expect(calls[1]?.[1]).toContain(reference.path);
    expect(calls[2]?.[1]).toContain(reference.path);
    expect(calls[2]?.[2]?.resolvedProvider).toBe('claude');
    expect(calls[3]?.[1]).toContain('qrst');
    expect(calls[3]?.[2]?.sessionId).toBe('fallback-session');
    expect(readFileSync(join(ctx.reportDir, 'review.md'), 'utf8')).toBe('# Report\nfallback verified');
  });

  it('retains every result across sessionless search and consecutive reads', async () => {
    const ctx = createContext(undefined);
    const search = JSON.stringify({ _takt_phase1_log_request: {
      operation: 'search', offset: 0, limit: 64, query: 'cdef',
    } });
    queue(
      response(search),
      response(request(12, 4)),
      response(request(20, 4)),
      response('# Report\nall evidence retained'),
    );

    await runReportPhase(step, 1, ctx);

    const calls = vi.mocked(runAgent).mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[2]?.[1]).toContain('@@ 12');
    expect(calls[2]?.[1]).toContain('Result content:\ncdef\n');
    expect(calls[3]?.[1]).toContain('@@ 12');
    expect(calls[3]?.[1]).toContain('Result content:\ncdef\n');
    expect(calls[3]?.[1]).toContain('Result content:\nklmn\n');
    expect(calls[3]?.[2]?.sessionId).toBeUndefined();
  });

  it('moves to a final report after the request budget instead of looping forever', async () => {
    const ctx = createContext(undefined);
    let attempt = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      attempt++;
      return attempt <= 5
        ? response(request((attempt - 1) * 2, 2))
        : response('# Report\npartially verified');
    });

    await runReportPhase(step, 1, ctx);

    const calls = vi.mocked(runAgent).mock.calls;
    expect(calls).toHaveLength(6);
    expect(calls[5]?.[1]).toContain('Read Budget Exhausted');
    for (const evidence of ['01', '23', '45', '67']) {
      expect(calls[5]?.[1]).toContain(`Result content:\n${evidence}\n`);
    }
    expect(readFileSync(join(ctx.reportDir, 'review.md'), 'utf8')).toBe('# Report\npartially verified');
  });

  it('carries acquired evidence through provider errors, fresh retry, exhaustion, and fallback', async () => {
    const ctx = createContext('phase1-session');
    const providerFailure = () => ({
      ...response('transport failed', 'report-session'),
      status: 'error' as const,
      error: 'transport failed',
    });
    queue(
      response(request(0, 2), 'report-session'),
      response(request(2, 2), 'report-session'),
      response(request(4, 2), 'report-session'),
      response(request(6, 2), 'report-session'),
      providerFailure(),
      response(request(8, 2)),
      providerFailure(),
      response('# Report\nfallback retained all evidence'),
    );

    await runReportPhase(step, 1, ctx);

    const calls = vi.mocked(runAgent).mock.calls;
    expect(calls).toHaveLength(8);
    for (const index of [5, 6, 7]) {
      for (const evidence of ['01', '23', '45', '67']) {
        expect(calls[index]?.[1]).toContain(`Result content:\n${evidence}\n`);
      }
    }
    expect(calls[5]?.[2]?.sessionId).toBeUndefined();
    expect(calls[6]?.[1]).toContain('Read Budget Exhausted');
    expect(calls[7]?.[2]?.resolvedProvider).toBe('claude');
    expect(readFileSync(join(ctx.reportDir, 'review.md'), 'utf8'))
      .toBe('# Report\nfallback retained all evidence');
  });

  it('carries the exhaustion notice and all evidence into retry and fallback after a final provider error', async () => {
    const ctx = createContext('phase1-session');
    const providerFailure = () => ({
      ...response('transport failed'),
      status: 'error' as const,
      error: 'transport failed',
    });
    queue(
      response(request(0, 2), 'report-session'),
      response(request(2, 2), 'report-session'),
      response(request(4, 2), 'report-session'),
      response(request(6, 2), 'report-session'),
      response(request(8, 2), 'report-session'),
      providerFailure(),
      providerFailure(),
      response('# Report\ncompleted without another read'),
    );

    await runReportPhase(step, 1, ctx);

    const calls = vi.mocked(runAgent).mock.calls;
    expect(calls).toHaveLength(8);
    for (const index of [6, 7]) {
      const prompt = calls[index]?.[1];
      expect(prompt).toContain('Read Budget Exhausted');
      expect(prompt?.match(/Read Budget Exhausted/g)).toHaveLength(1);
      for (const evidence of ['01', '23', '45', '67']) {
        expect(prompt).toContain(`Result content:\n${evidence}\n`);
      }
      expect(calls[index]?.[2]?.sessionId).toBeUndefined();
    }
    expect(calls[7]?.[2]?.resolvedProvider).toBe('claude');
    expect(readFileSync(join(ctx.reportDir, 'review.md'), 'utf8'))
      .toBe('# Report\ncompleted without another read');
  });

  it.each(['read', 'search'] as const)('routes an out-of-range %s offset through retry and fallback', async (operation) => {
    const ctx = createContext('phase1-session');
    const invalidRequest = operation === 'read'
      ? request(reference.byteSize + 1, 5)
      : JSON.stringify({ _takt_phase1_log_request: {
        operation: 'search', offset: reference.byteSize + 1, limit: 64, query: 'missing',
      } });
    queue(
      response(invalidRequest, 'report-session'),
      response(invalidRequest),
      response('# Report\nout-of-range request recovered'),
    );

    await runReportPhase(step, 1, ctx);

    const calls = vi.mocked(runAgent).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[2]?.[2]?.resolvedProvider).toBe('claude');
    expect(readFileSync(join(ctx.reportDir, 'review.md'), 'utf8'))
      .toBe('# Report\nout-of-range request recovered');
  });

  it('allows a read at the exact EOF offset', async () => {
    const ctx = createContext('phase1-session');
    queue(response(request(reference.byteSize, 5), 'report-session'), response('# Report\nEOF verified'));

    await runReportPhase(step, 1, ctx);

    expect(vi.mocked(runAgent).mock.calls[1]?.[1]).toContain('"nextOffset":null');
    expect(readFileSync(join(ctx.reportDir, 'review.md'), 'utf8')).toBe('# Report\nEOF verified');
  });

  it('rejects an invalid reserved request instead of saving it as a report', async () => {
    const ctx = createContext('phase1-session');
    queue(response(JSON.stringify({ _takt_phase1_log_request: {
      operation: 'read', offset: 0, limit: 5, path: '/unauthorized',
    } })));

    await expect(generateReportPhase(step, 1, ctx, { retryMode: 'single-attempt' }))
      .rejects.toBeInstanceOf(ReportPhaseGenerationError);
    expect(existsSync(join(ctx.reportDir, 'review.md'))).toBe(false);
  });
});
