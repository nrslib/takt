import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolPermissionDecisionHandler } from '../core/workflow/types.js';
import { requestCodexToolPermissionDecision } from '../infra/codex/tool-permission-hook.js';
import {
  CODEX_TOOL_PERMISSION_DECISION_TIMEOUT_MS,
  CODEX_TOOL_PERMISSION_HANDLER_TIMEOUT_MS,
  parseCodexToolPermissionInput, parseCodexToolPermissionDecision,
  parseCodexToolPermissionOutput, toCodexToolPermissionOutput,
  codexToolPermissionDenial, buildCodexToolPermissionHookConfig,
} from '../infra/codex/tool-permission-hook-protocol.js';

const request = { toolName: 'Bash', toolInput: { command: 'pwd' }, cwd: '/fixture/actual-tool' };
afterEach(() => vi.useRealTimers());

describe('Codex hook protocol', () => {
  it('keeps the actual tool cwd and arguments from the hook input', () => {
    expect(parseCodexToolPermissionInput({
      hook_event_name: 'PreToolUse', tool_name: request.toolName, tool_input: request.toolInput, cwd: request.cwd,
    })).toEqual(request);
  });

  it.each([null, [], {}, { hook_event_name: 'PostToolUse' }, {
    hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/fixture',
  }])('rejects malformed hook input: %j', (value) => {
    expect(() => parseCodexToolPermissionInput(value)).toThrow();
  });

  it.each(['allow', 'deny'] as const)('serializes and validates %s output', (decision) => {
    const value = decision === 'allow' ? { decision } : { decision, reason: 'fixture refusal' };
    expect(parseCodexToolPermissionDecision(value)).toEqual(value);
    const output = toCodexToolPermissionOutput(value);
    const expected = { hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: decision,
      permissionDecisionReason: decision === 'deny' ? 'fixture refusal' : '',
    } };
    expect(output).toEqual(expected);
    expect(parseCodexToolPermissionOutput(output)).toEqual(expected);
    if (decision === 'deny') expect(codexToolPermissionDenial('fixture refusal')).toEqual(output);
  });

  it('normalizes an external allow without a reason to the complete output shape', () => {
    expect(parseCodexToolPermissionOutput({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'allow',
    } })).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: '',
    } });
  });

  it.each([null, {}, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: ' ' },
  }])('rejects invalid external hook output: %j', (value) => {
    expect(() => parseCodexToolPermissionOutput(value)).toThrow();
  });

  it('builds the command hook definition without changing its command or deadlines', () => {
    expect(buildCodexToolPermissionHookConfig({ command: 'fixture command', matcher: '.*', timeout: 90 })).toEqual({
      PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'fixture command', timeout: 90 }] }],
    });
  });
});

describe('Codex permission decision boundary', () => {
  it.each(['allow', 'deny'] as const)('preserves a valid %s decision and calls the handler once', async (decision) => {
    const expected = decision === 'allow' ? { decision: 'allow' as const } : { decision: 'deny' as const, reason: 'operation refused' };
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue(expected);
    await expect(requestCodexToolPermissionDecision(handler, request)).resolves.toEqual(expected);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0]).toMatchObject(request);
  });

  it.each([null, {}, { decision: 'ask', reason: 'ask someone' }, { decision: 'deny', reason: '' }, { decision: 'deny', reason: '   ' }])('denies an invalid decision without retrying: %j', async (value) => {
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue(value as never);
    await expect(requestCodexToolPermissionDecision(handler, request)).resolves.toMatchObject({ decision: 'deny', reason: expect.stringMatching(/\S/u) });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('turns a handler exception into a reasoned denial without retrying', async () => {
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockRejectedValue(new Error('fixture failure'));
    await expect(requestCodexToolPermissionDecision(handler, request)).resolves.toMatchObject({ decision: 'deny', reason: expect.stringMatching(/\S/u) });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('denies before the command deadline and rejects a late allowance even when the handler ignores cancellation', async () => {
    vi.useFakeTimers();
    let finish!: (decision: { decision: 'allow' }) => void;
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    let decision: unknown;
    const pending = requestCodexToolPermissionDecision(handler, request).then((result) => { decision = result; return result; });
    expect(CODEX_TOOL_PERMISSION_DECISION_TIMEOUT_MS).toBeLessThan(CODEX_TOOL_PERMISSION_HANDLER_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(CODEX_TOOL_PERMISSION_DECISION_TIMEOUT_MS - 1);
    expect(decision).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ decision: 'deny', reason: expect.stringMatching(/\S/u) });
    finish({ decision: 'allow' });
    await Promise.resolve();
    expect(decision).toMatchObject({ decision: 'deny' });
    expect(handler).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
