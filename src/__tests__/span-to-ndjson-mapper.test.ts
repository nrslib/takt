import { describe, expect, it } from 'vitest';
import {
  mapSpanEndToNdjson,
  mapSpanStartToNdjson,
  type SpanSnapshot,
} from '../core/logging/span-to-ndjson-mapper.js';

describe('span-to-ndjson mapper', () => {
  it('maps step span start and end into session log compatible records', () => {
    const stack = [
      { workflow: 'parent', workflow_ref: 'project:sha256:parent', step: 'delegate', kind: 'workflow_call' },
      { workflow: 'child', workflow_ref: 'project:sha256:child', step: 'implement', kind: 'agent' },
    ];
    const baseSpan: SpanSnapshot = {
      name: 'step.implement',
      startTime: [1_778_777_200, 123_000_000],
      endTime: [1_778_777_210, 456_000_000],
      attributes: {
        'takt.workflow.name': 'parent',
        'takt.workflow.current_name': 'child',
        'takt.workflow.stack': JSON.stringify(stack),
        'takt.step.name': 'implement',
        'takt.step.persona': 'coder',
        'takt.step.iteration': 2,
        'takt.step.instruction': 'Implement it',
        'takt.provider.name': 'codex',
        'takt.provider.source': 'project',
        'takt.model.name': 'gpt-5',
        'takt.model.source': 'global',
        'takt.step.status': 'done',
        'takt.step.result.persona': 'coder',
        'takt.step.result.content': 'done',
        'takt.step.result.timestamp': '2026-05-18T00:00:00.000Z',
        'takt.step.result.matched_rule_index': 0,
        'takt.step.result.matched_rule_method': 'structured_output',
        'takt.step.result.match_method': 'structured_output',
        'takt.step.result.failure_category': 'provider_error',
      },
    };

    expect(mapSpanStartToNdjson(baseSpan)).toEqual({
      type: 'step_start',
      step: 'implement',
      persona: 'coder',
      iteration: 2,
      timestamp: '2026-05-14T16:46:40.123Z',
      workflow: 'child',
      stack,
      instruction: 'Implement it',
      provider: 'codex',
      providerSource: 'project',
      model: 'gpt-5',
      modelSource: 'global',
    });

    expect(mapSpanEndToNdjson(baseSpan)).toEqual({
      type: 'step_complete',
      step: 'implement',
      persona: 'coder',
      iteration: 2,
      status: 'done',
      content: 'done',
      instruction: 'Implement it',
      workflow: 'child',
      stack,
      matchedRuleIndex: 0,
      matchedRuleMethod: 'structured_output',
      matchMethod: 'structured_output',
      failureCategory: 'provider_error',
      timestamp: '2026-05-18T00:00:00.000Z',
    });
  });

  it('parses provider options from the step span into step_start', () => {
    const span: SpanSnapshot = {
      name: 'step.implement',
      startTime: [1_778_777_200, 0],
      attributes: {
        'takt.step.name': 'implement',
        'takt.step.persona': 'coder',
        'takt.step.iteration': 1,
        'takt.provider.name': 'codex',
        'takt.provider.source': 'project',
        'takt.provider.options': JSON.stringify({ codex: { reasoningEffort: 'high' } }),
        'takt.provider.options_sources': JSON.stringify({ 'codex.reasoningEffort': 'project' }),
      },
    };

    expect(mapSpanStartToNdjson(span)).toMatchObject({
      type: 'step_start',
      provider: 'codex',
      providerOptions: { codex: { reasoningEffort: 'high' } },
      providerOptionsSources: { 'codex.reasoningEffort': 'project' },
    });
  });

  it('omits invalid failureCategory values from mapped records', () => {
    expect(mapSpanEndToNdjson({
      name: 'step.implement',
      attributes: {
        'takt.step.name': 'implement',
        'takt.step.persona': 'coder',
        'takt.step.iteration': 1,
        'takt.step.status': 'error',
        'takt.step.result.content': 'failed',
        'takt.step.result.failure_category': 'unexpected',
      },
    })).toEqual({
      type: 'step_complete',
      step: 'implement',
      persona: 'coder',
      iteration: 1,
      status: 'error',
      content: 'failed',
      instruction: '',
      timestamp: expect.any(String),
    });
  });

  it('maps terminal workflow spans and skips non-terminal running spans', () => {
    expect(mapSpanEndToNdjson({
      name: 'workflow.default',
      endTime: [1_778_777_300, 0],
      attributes: {
        'takt.workflow.status': 'completed',
        'takt.workflow.iterations': 3,
      },
    })).toEqual({
      type: 'workflow_complete',
      iterations: 3,
      endTime: '2026-05-14T16:48:20.000Z',
    });

    expect(mapSpanEndToNdjson({
      name: 'workflow.default',
      attributes: {
        'takt.workflow.status': 'running',
      },
    })).toBeUndefined();
  });

  it('skips workflow_start discoverability spans for shadow session log parity', () => {
    const span: SpanSnapshot = {
      name: 'workflow_start.default',
      startTime: [1_778_777_200, 0],
      endTime: [1_778_777_200, 1_000_000],
      attributes: {
        'takt.run.id': 'run-1',
        'takt.workflow.name': 'default',
        'takt.workflow.status': 'running',
      },
    };

    expect(mapSpanStartToNdjson(span)).toBeUndefined();
    expect(mapSpanEndToNdjson(span)).toBeUndefined();
  });

  it('does not treat workflow_start spans with terminal-looking attributes as workflow records', () => {
    const span: SpanSnapshot = {
      name: 'workflow_start.default',
      endTime: [1_778_777_300, 0],
      attributes: {
        'takt.workflow.status': 'completed',
        'takt.workflow.iterations': 3,
      },
    };

    expect(mapSpanEndToNdjson(span)).toBeUndefined();
  });

  it('skips nested workflow terminal spans for shadow session log parity', () => {
    expect(mapSpanEndToNdjson({
      name: 'workflow.child',
      endTime: [1_778_777_300, 0],
      attributes: {
        'takt.workflow.status': 'completed',
        'takt.workflow.iterations': 1,
        'takt.workflow.resume_depth': 1,
      },
    })).toBeUndefined();
  });

  it('maps phase spans into session log compatible phase records', () => {
    const stack = [
      { workflow: 'default', step: 'implement', kind: 'agent' },
    ];
    const phaseSpan: SpanSnapshot = {
      name: 'phase.implement.execute',
      startTime: [1_778_777_200, 0],
      endTime: [1_778_777_205, 0],
      attributes: {
        'takt.workflow.current_name': 'default',
        'takt.workflow.stack': JSON.stringify(stack),
        'takt.step.name': 'implement',
        'takt.step.iteration': 1,
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.execution_id': 'implement:1:1',
        'takt.phase.instruction': 'Implement it',
        'takt.phase.system_prompt': 'System prompt',
        'takt.phase.user_instruction': 'User instruction',
        'takt.phase.status': 'done',
        'takt.phase.result.content': 'implemented',
      },
    };

    expect(mapSpanStartToNdjson(phaseSpan)).toEqual({
      type: 'phase_start',
      step: 'implement',
      iteration: 1,
      workflow: 'default',
      stack,
      phase: 1,
      phaseName: 'execute',
      phaseExecutionId: 'implement:1:1',
      timestamp: '2026-05-14T16:46:40.000Z',
      instruction: 'Implement it',
      systemPrompt: 'System prompt',
      userInstruction: 'User instruction',
    });
    expect(mapSpanEndToNdjson(phaseSpan)).toEqual({
      type: 'phase_complete',
      step: 'implement',
      iteration: 1,
      workflow: 'default',
      stack,
      phase: 1,
      phaseName: 'execute',
      phaseExecutionId: 'implement:1:1',
      status: 'done',
      content: 'implemented',
      timestamp: '2026-05-14T16:46:45.000Z',
    });
  });

  it('skips phase spans without execution ids to avoid shadow-only phase records', () => {
    const span: SpanSnapshot = {
      name: 'phase.implement.execute',
      attributes: {
        'takt.step.name': 'implement',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
      },
    };

    expect(mapSpanStartToNdjson(span)).toBeUndefined();
    expect(mapSpanEndToNdjson(span)).toBeUndefined();
  });

  it('omits phase_start but keeps phase_complete when prompt parts were never resolved (judge error path)', () => {
    const span: SpanSnapshot = {
      name: 'phase.implement.judge',
      endTime: [1_778_777_210, 0],
      attributes: {
        'takt.step.name': 'implement',
        'takt.step.iteration': 2,
        'takt.phase.number': 3,
        'takt.phase.name': 'judge',
        'takt.phase.execution_id': 'implement:3:2:1',
        'takt.phase.status': 'error',
        'takt.phase.result.error': 'provider connection failed',
      },
    };

    // phase_start legitimately needs resolved prompt parts (parity: canonical
    // only emits phase_start once onStructuredPromptResolved fired).
    expect(mapSpanStartToNdjson(span)).toBeUndefined();
    // phase_complete must still be emitted: the canonical log writes a
    // phase_complete(status=error) unconditionally in the judge catch block.
    expect(mapSpanEndToNdjson(span)).toEqual({
      type: 'phase_complete',
      step: 'implement',
      iteration: 2,
      phase: 3,
      phaseName: 'judge',
      phaseExecutionId: 'implement:3:2:1',
      status: 'error',
      error: 'provider connection failed',
      timestamp: '2026-05-14T16:46:50.000Z',
    });
  });

  it.each(['execute', 'report'] as const)(
    'drops phase_complete for a %s phase that errored before prompt parts resolved',
    (phaseName) => {
      const span: SpanSnapshot = {
        name: `phase.implement.${phaseName}`,
        endTime: [1_778_777_210, 0],
        attributes: {
          'takt.step.name': 'implement',
          'takt.step.iteration': 1,
          'takt.phase.number': phaseName === 'execute' ? 1 : 2,
          'takt.phase.name': phaseName,
          'takt.phase.execution_id': `implement:${phaseName === 'execute' ? 1 : 2}:1:1`,
          'takt.phase.status': 'error',
          'takt.phase.result.error': 'agent failed to start',
        },
      };

      // Canonical emits NO phase_complete for execute/report when the agent
      // throws before prompts resolve (StepExecutor has no try/catch; report
      // guards onPhaseComplete with didEmitPhaseStart). The shadow log must
      // not emit an orphaned phase_complete with no preceding phase_start.
      expect(mapSpanStartToNdjson(span)).toBeUndefined();
      expect(mapSpanEndToNdjson(span)).toBeUndefined();
    },
  );

  it('maps judge stage spans into session log compatible judge records', () => {
    expect(mapSpanEndToNdjson({
      name: 'judge_stage.implement.1.structured_output',
      endTime: [1_778_777_210, 0],
      attributes: {
        'takt.step.name': 'implement',
        'takt.step.iteration': 1,
        'takt.phase.execution_id': 'implement:3:1',
        'takt.judge.stage': 1,
        'takt.judge.method': 'structured_output',
        'takt.judge.status': 'done',
        'takt.judge.instruction': 'Judge it',
        'takt.judge.response': 'ok',
      },
    })).toEqual({
      type: 'phase_judge_stage',
      step: 'implement',
      iteration: 1,
      phase: 3,
      phaseName: 'judge',
      phaseExecutionId: 'implement:3:1',
      stage: 1,
      method: 'structured_output',
      status: 'done',
      instruction: 'Judge it',
      response: 'ok',
      timestamp: '2026-05-14T16:46:50.000Z',
    });
  });
});
