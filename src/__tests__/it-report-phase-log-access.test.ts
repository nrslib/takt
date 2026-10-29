import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResponse } from '../core/models/types.js';
import { Phase1ExecutionLog, savePhase1ExecutionLog, type Phase1ExecutionLogReference } from '../core/workflow/phase1-execution-log.js';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { generateReportPhase, ReportPhaseGenerationError, type ReportPhaseRunnerContext } from '../core/workflow/phase-runner.js';
import type { ProviderType, StreamEvent } from '../shared/types/provider.js';
import type { RunAgentOptions } from '../agents/runner.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
import { runAgent } from '../agents/runner.js';

const step = {
  name: 'review', persona: 'reviewer', personaDisplayName: 'Reviewer', instruction: 'Review current work',
  passPreviousResponse: false, outputContracts: [{ name: 'review.md', format: '# Report' }],
};

function response(content: string): AgentResponse {
  return { persona: 'reviewer', status: 'done', content, timestamp: new Date() };
}

describe('Phase 2 direct readonly access to the Phase 1 log', () => {
  let directory: string;
  let reference: Phase1ExecutionLogReference;
  beforeEach(async () => {
    vi.resetAllMocks();
    directory = mkdtempSync(join(tmpdir(), 'takt-report-log-access-'));
    const log = new Phase1ExecutionLog();
    log.recordEvent({ type: 'tool_result', data: { id: 'phase1', content: 'verified current evidence; password=synthetic-secret', isError: false } });
    reference = await savePhase1ExecutionLog(log, directory, 'review', 1);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function createContext(provider: ProviderType, sessionId: string | undefined = 'phase1-session'): ReportPhaseRunnerContext {
    const reportDir = join(directory, 'reports');
    const builder = new OptionsBuilder({ projectCwd: directory, provider, model: 'offline', onStream: (event) => context.onStream?.(event) }, () => directory, () => directory,
      () => sessionId, () => reportDir, () => 'en', () => 'log-access');
    const context: ReportPhaseRunnerContext = {
      workflowName: 'log-access', cwd: directory, reportDir, language: 'en',
      lastResponse: 'Current work summary', phase1ExecutionLog: reference,
      resolveSessionKey: () => 'reviewer', getSessionId: () => sessionId,
      buildResumeOptions: builder.buildResumeOptions.bind(builder),
      buildNewSessionReportOptions: builder.buildNewSessionReportOptions.bind(builder),
      buildFallbackReportOptions: builder.buildFallbackReportOptions.bind(builder),
      resolveReportFallbackProviderModel: () => undefined,
      resolveStepProviderModel: () => ({ provider, model: 'offline' }), updatePersonaSession: vi.fn(),
    };
    return context;
  }

  function queue(events: readonly StreamEvent[], content = '# Report\nverified'): void {
    vi.mocked(runAgent).mockImplementationOnce(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      for (const event of events) options?.onStream?.(event);
      return response(content);
    });
  }

  it('saves a private masked JSONL reference with the actual byte size', async () => {
    const content = readFileSync(reference.path, 'utf8');
    expect(reference.path).toMatch(/\.jsonl$/);
    expect(content).not.toContain('synthetic-secret');
    expect(JSON.parse(content.trim()).event.data.content).toContain('[REDACTED]');
    expect(reference.byteSize).toBe(Buffer.byteLength(content));
    if (process.platform !== 'win32') expect(statSync(reference.path).mode & 0o777).toBe(0o600);
    const log = new Phase1ExecutionLog();
    log.recordResult({ status: 'done', content: 'another execution' });
    const next = await savePhase1ExecutionLog(log, directory, '../review', 2);
    expect(next.path).not.toBe(reference.path);
    expect(readFileSync(reference.path, 'utf8')).toBe(content);
  });

  it.each([
    ['claude', 'Read'], ['claude-sdk', 'Grep'], ['claude-headless', 'Glob'], ['claude-terminal', 'Read'],
    ['claude', 'Bash'], ['claude-sdk', 'Bash'], ['claude-headless', 'Bash'], ['claude-terminal', 'Bash'],
    ['codex', 'Bash'], ['opencode', 'read'], ['opencode', 'glob'], ['opencode', 'grep'],
    ['opencode', 'list'], ['opencode', 'skill'],
    ['copilot', 'view'], ['copilot', 'glob'], ['copilot', 'grep'], ['kiro', 'read'], ['kiro', 'grep'],
    ['cursor', 'readToolCall'], ['cursor', 'lsToolCall'], ['cursor', 'globToolCall'], ['cursor', 'grepToolCall'],
    ['cursor', 'semSearchToolCall'], ['cursor', 'readLintsToolCall'], ['cursor', 'readTodosToolCall'],
    ['devin', 'read'], ['devin', 'glob'], ['devin', 'grep'],
    ['pi', 'read'], ['pi', 'find'], ['pi', 'grep'], ['pi', 'ls'], ['pi', 'codemode'], ['mock', 'Read'],
  ] as const)('accepts %s/%s and its matching output in a single call', async (provider, tool) => {
    const ctx = createContext(provider);
    const stream = vi.fn();
    ctx.onStream = stream;
    queue([
      { type: 'tool_use', data: { id: 'read-1', tool, input: { path: reference.path, offset: 1, limit: 1 } } },
      { type: 'tool_output', data: { id: 'read-1', tool, output: 'evidence' } },
      { type: 'tool_result', data: { id: 'read-1', content: 'evidence', isError: false } },
    ]);
    const result = await generateReportPhase(step, 1, ctx);
    expect(result).toMatchObject({ reports: [{ reportContent: '# Report\nverified' }] });
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
    expect(vi.mocked(runAgent).mock.calls[0]![1]).toContain(reference.path);
    expect(vi.mocked(runAgent).mock.calls[0]![1]).not.toContain('verified current evidence');
    expect(stream).toHaveBeenCalledTimes(3);
    expect(existsSync(join(ctx.reportDir, 'review.md'))).toBe(false);
  });

  it('accepts batched completion ids and legitimate search errors', async () => {
    queue([
      { type: 'tool_use', data: { id: 'a', tool: 'Grep', input: {} } },
      { type: 'tool_use', data: { id: 'b', tool: 'Read', input: {} } },
      { type: 'tool_result', data: { completedToolIds: ['a', 'b'], content: 'No matches', isError: true } },
    ]);
    await expect(generateReportPhase(step, 1, createContext('claude'))).resolves.toHaveProperty('reports');
  });

  it.each([
    { resumed: true, resolution: 'resolvedExecution' },
    { resumed: false, resolution: 'resolvedExecution' },
    { resumed: true, resolution: 'resolvedProvider' },
    { resumed: false, resolution: 'resolvedProvider' },
  ] as const)('uses the execution provider for tools and report identity: %j', async ({ resumed, resolution }) => {
    const ctx = createContext('claude');
    ctx.getSessionId = () => resumed ? 'phase1-session' : undefined;
    const execution = { provider: 'codex', model: 'report-model', providerOptions: undefined, permissionMode: 'readonly' } as const;
    const common: RunAgentOptions = {
      cwd: directory,
      executionPhase: 2,
      allowedTools: [],
      ...(resolution === 'resolvedExecution'
        ? { resolvedExecution: execution }
        : { resolvedProvider: execution.provider, resolvedModel: execution.model, permissionMode: execution.permissionMode }),
    };
    ctx.buildResumeOptions = (_step, sessionId, overrides) => ({ ...common, sessionId, maxTurns: overrides.maxTurns });
    ctx.buildNewSessionReportOptions = (_step, overrides) => ({ ...common, maxTurns: overrides.maxTurns });
    queue([
      { type: 'tool_use', data: { id: 'read-1', tool: 'Bash', input: { command: `head -n 1 ${reference.path}` } } },
      { type: 'tool_result', data: { id: 'read-1', content: 'evidence', isError: false } },
    ]);
    const result = await generateReportPhase(step, 1, ctx, { retryMode: 'single-attempt' });
    expect(result).toMatchObject({ reports: [{ attemptIdentity: {
      providerInfo: { provider: 'codex', model: 'report-model' },
      agentOptions: common,
    } }] });
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
    const callOptions = vi.mocked(runAgent).mock.calls[0]![2];
    expect(callOptions).toMatchObject(common);
    expect(callOptions.sessionId).toBe(resumed ? 'phase1-session' : undefined);

    queue([{ type: 'tool_use', data: { id: 'wrong-provider', tool: 'Read', input: {} } }]);
    await expect(generateReportPhase(step, 1, ctx, { retryMode: 'single-attempt' }))
      .rejects.toMatchObject({ failureReason: 'tool_call' });
  });

  it.each<StreamEvent>([
    { type: 'tool_use', data: { id: 'a', tool: 'Write', input: {} } },
    { type: 'tool_use', data: { id: 'a', tool: 'mcp__evil__Read', input: {} } },
    { type: 'tool_use', data: { id: 'a', tool: 'read', input: {} } },
    { type: 'tool_result', data: { id: 'phase1', content: 'stale', isError: false } },
    { type: 'tool_result', data: { completedToolIds: ['a', 'unknown'], content: 'mixed', isError: false } },
    { type: 'tool_result', data: { content: 'idless', isError: false } },
    { type: 'tool_output', data: { tool: 'Read', output: 'idless' } },
    { type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'mismatch' } },
  ])('rejects unauthorized or uncorrelated events: %j', async (event) => {
    const ctx = createContext('claude');
    ctx.onStream = vi.fn();
    queue([{ type: 'tool_use', data: { id: 'a', tool: 'Read', input: {} } }, event]);
    await expect(generateReportPhase(step, 1, ctx, { retryMode: 'single-attempt' })).rejects.toMatchObject({
      name: 'ReportPhaseGenerationError', failureReason: 'tool_call',
    });
    expect(ctx.onStream).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['codex', 'Read'], ['codex', 'WebSearch'], ['codex', 'mcp__server__Read'],
    ['opencode', 'bash'], ['opencode', 'StructuredOutput'], ['pi', 'bash'], ['pi', 'write'],
    ['opencode', 'write'], ['opencode', 'apply_patch'], ['opencode', 'task'], ['opencode', 'todowrite'],
    ['opencode', 'todoread'], ['opencode', 'webfetch'], ['opencode', 'websearch'],
    ['copilot', 'shell'], ['copilot', 'edit'], ['kiro', 'shell'], ['kiro', 'write'],
    ['cursor', 'shellToolCall'], ['cursor', 'editToolCall'], ['cursor', 'mcpToolCall'],
    ['devin', 'Bash'], ['devin', 'edit'], ['devin', 'mcp__server__read'],
  ] as const)('rejects tools outside the actual Phase 2 set: %s/%s', async (provider, tool) => {
    queue([{ type: 'tool_use', data: { id: 'forbidden', tool, input: {} } }]);
    await expect(generateReportPhase(step, 1, createContext(provider), { retryMode: 'single-attempt' }))
      .rejects.toMatchObject({ failureReason: 'tool_call' });
  });

  it('does not reuse allowed call ids after a new-session retry', async () => {
    const ctx = createContext('claude');
    queue([{ type: 'tool_use', data: { id: 'a', tool: 'Read', input: {} } }], '');
    queue([{ type: 'tool_result', data: { id: 'a', content: 'stale', isError: false } }]);
    await expect(generateReportPhase(step, 1, ctx)).rejects.toBeInstanceOf(ReportPhaseGenerationError);
    expect(vi.mocked(runAgent).mock.calls[1]![2]!.sessionId).toBeUndefined();
  });
});
