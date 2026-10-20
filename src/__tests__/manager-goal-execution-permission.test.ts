import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagerToolPermissionHandler } from '../features/manager/toolPermissionDecision.js';
import { judgeManagerToolPermission, type ManagerPermissionJudgePlan } from '../features/manager/toolPermissionJudge.js';
import { saveManagerToolPermissionInquiry } from '../features/manager/toolPermissionInquiry.js';
import { buildSdkOptions } from '../infra/claude/options-builder.js';
import { parseCodexToolPermissionInput, toCodexToolPermissionOutput } from '../infra/codex/tool-permission-hook-protocol.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { goalId } from './helpers/goal-fixtures.js';

vi.mock('../features/manager/toolPermissionJudge.js', () => ({ judgeManagerToolPermission: vi.fn() }));
vi.mock('../features/manager/toolPermissionInquiry.js', () => ({ saveManagerToolPermissionInquiry: vi.fn() }));
vi.mock('../features/manager/toolPermissionNotification.js', () => ({ notifyManagerToolPermission: vi.fn() }));

const cwd = '/repository';
const plan: ManagerPermissionJudgePlan = {
  language: 'ja', systemPrompt: 'permission fixture', managerPersona: 'manager fixture', managerPolicy: 'policy fixture',
  resolution: { provider: 'mock', model: undefined, providerOptions: {} },
};
const inquiryId = '650e8400-e29b-41d4-a716-446655440001';
const onDenial = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(judgeManagerToolPermission).mockResolvedValue({ decision: 'ask', reason: '人の確認が必要です' });
  vi.mocked(saveManagerToolPermissionInquiry).mockImplementation(async ({ request, reason }) => ({
    ...createInquiry({ kind: 'approval', body: reason,
      operation: { toolName: request.toolName, args: JSON.stringify(request.toolInput), cwd: request.cwd } }),
    id: inquiryId,
  }));
});

describe.each(['claude', 'claude-sdk', 'codex'] as const)('%s goal execution permission boundary', (provider) => {
  it.each(['takt_pause_goal', 'takt_resume_goal', 'takt_abort_goal'] as const)('routes %s through PreToolUse to the judge and denies while confirmation is pending', async (name) => {
    const toolName = `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__${name}`;
    const toolInput = { cwd, goalId, ...(name === 'takt_abort_goal' ? { reason: '作業を取りやめます' } : {}) };
    const signal = new AbortController().signal;
    const handler = createManagerToolPermissionHandler({
      plan, provider, cwd, configDirectory: '/isolated/config', owner: { kind: 'repository', repositoryDirectory: cwd },
      instruction: 'このゴールの実行状態を変えてください', abortSignal: signal, onDenial,
    });
    const hookInput = { hook_event_name: 'PreToolUse' as const, session_id: 'permission-test', transcript_path: '/fixture/transcript',
      cwd, tool_name: toolName, tool_input: toolInput, tool_use_id: 'goal-operation' };
    let output: unknown;
    if (provider === 'codex') {
      const request = parseCodexToolPermissionInput(hookInput);
      expect(request).toMatchObject({ toolName, toolInput, cwd });
      output = toCodexToolPermissionOutput(await handler({ ...request, abortSignal: signal }));
    } else {
      const options = buildSdkOptions({ cwd, onToolPermissionDecision: handler });
      const hook = options.hooks?.PreToolUse?.find(({ matcher }) => matcher === undefined)?.hooks[0];
      expect(hook).toBeTypeOf('function');
      output = await hook!(hookInput, 'goal-operation', { signal });
    }

    expect(judgeManagerToolPermission).toHaveBeenCalledOnce();
    expect(vi.mocked(judgeManagerToolPermission).mock.calls[0]![1]).toMatchObject({ toolName, toolInput, cwd });
    expect(saveManagerToolPermissionInquiry).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ toolName, toolInput, cwd }), owner: { kind: 'repository', repositoryDirectory: cwd },
    }));
    expect(output).toMatchObject({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining(inquiryId),
    } });
    expect(onDenial).toHaveBeenCalledOnce();
  });
});
