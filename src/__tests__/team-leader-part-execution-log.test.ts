import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import type { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { runTeamLeaderPart } from '../core/workflow/engine/team-leader-part-runner.js';
import { createTeamLeaderPartCancellation } from '../core/workflow/engine/team-leader-part-cancellation.js';
import { Phase1ExecutionLog } from '../core/workflow/phase1-execution-log.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
import { runAgent } from '../agents/runner.js';

const step = {
  name: 'review', persona: 'reviewer', personaDisplayName: 'Reviewer', instruction: 'Review',
  teamLeader: { partPersona: 'reviewer', partEdit: false, partPermissionMode: 'readonly' },
} as WorkflowStep;
const part = { id: 'part-1', title: 'Inspect', instruction: 'Inspect source' };
const providerInfo = { provider: 'mock' as const, model: undefined };
const optionsBuilder = {
  buildAgentOptions: () => ({ cwd: process.cwd(), provider: 'mock', permissionMode: 'readonly' }),
} as unknown as OptionsBuilder;

const completed: AgentResponse = {
  persona: 'reviewer', status: 'done', content: 'This result must not be published', timestamp: new Date(),
};

describe('team leader part execution log', () => {
  it.each(['response_race', 'throw'] as const)('records cancellation without a completed result (%s)', async (mode) => {
    const controller = new AbortController();
    const cancellation = createTeamLeaderPartCancellation(part.id);
    const log = new Phase1ExecutionLog();
    vi.mocked(runAgent).mockImplementationOnce(async (_persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: 'reviewer', userInstruction: instruction });
      options.onDispatch?.(options.permissionMode);
      options.onStream?.({ type: 'tool_result', data: { id: 'read', content: 'partial evidence', isError: false } });
      controller.abort(cancellation);
      if (mode === 'throw') throw cancellation;
      return completed;
    });

    await expect(runTeamLeaderPart(
      optionsBuilder, step, undefined, part, 0, 1000, () => undefined, undefined,
      { enabled: false, workflowName: 'test', iteration: 1 },
      () => 'Inspect source', undefined, undefined,
      { forceNewSession: false, deadlineSignal: controller.signal, providerInfo, phase1ExecutionLog: log },
    )).rejects.toBe(cancellation);

    const entries = JSON.parse(log.toReportInput()) as Array<{ kind: string; status?: string; content?: string }>;
    expect(entries.filter((entry) => entry.kind === 'attempt_result').map((entry) => entry.status))
      .toEqual(['cancelled']);
    expect(log.toReportInput()).toContain('partial evidence');
    expect(log.toReportInput()).not.toContain(completed.content);
  });
});
