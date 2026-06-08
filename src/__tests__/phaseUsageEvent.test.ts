import { describe, expect, it } from 'vitest';
import {
  mapSpanEndToPhaseUsageEvent,
  type PhaseUsageEventContext,
} from '../core/logging/phaseUsageEvent.js';
import type { SpanSnapshot } from '../core/logging/span-to-ndjson-mapper.js';

const context: PhaseUsageEventContext = {
  runId: 'run-1',
  sessionId: 'session-1',
};

describe('phase usage event mapper', () => {
  it('maps phase 1 spans into phase usage event records', () => {
    const span: SpanSnapshot = {
      name: 'phase.implement.execute',
      endTime: [1_778_777_205, 0],
      attributes: {
        'takt.provider.name': 'codex',
        'takt.model.name': 'gpt-5',
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.execution_id': 'implement:1:1:1',
        'takt.phase.status': 'done',
        'takt.usage.missing': false,
        'gen_ai.usage.input_tokens': 11,
        'gen_ai.usage.output_tokens': 7,
        'gen_ai.usage.total_tokens': 18,
        'gen_ai.usage.cached_input_tokens': 3,
        'gen_ai.usage.cache_creation_input_tokens': 2,
        'gen_ai.usage.cache_read_input_tokens': 1,
      },
    };

    expect(mapSpanEndToPhaseUsageEvent(span, context)).toEqual({
      run_id: 'run-1',
      session_id: 'session-1',
      provider: 'codex',
      provider_model: 'gpt-5',
      step: 'implement',
      step_type: 'normal',
      phase: 'phase1_execute',
      phase_name: 'execute',
      phase_execution_id: 'implement:1:1:1',
      timestamp: '2026-05-14T16:46:45.000Z',
      success: true,
      usage_missing: false,
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        cached_input_tokens: 3,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 1,
      },
    });
  });

  it('maps phase 2 missing usage with a normalized reason', () => {
    const span: SpanSnapshot = {
      name: 'phase.review.report',
      endTime: [1_778_777_210, 0],
      attributes: {
        'takt.provider.name': 'claude',
        'takt.step.name': 'review',
        'takt.step.type': 'normal',
        'takt.phase.number': 2,
        'takt.phase.name': 'report',
        'takt.phase.status': 'error',
        'takt.usage.missing': true,
        'takt.usage.missing_reason': 'unexpected',
      },
    };

    expect(mapSpanEndToPhaseUsageEvent(span, context)).toEqual(expect.objectContaining({
      provider: 'claude',
      provider_model: '(default)',
      phase: 'phase2_report',
      phase_name: 'report',
      success: false,
      usage_missing: true,
      reason: 'usage_not_available',
      usage: {},
    }));
  });

  it('maps judge stage spans into stage-specific phase usage records', () => {
    const span: SpanSnapshot = {
      name: 'judge_stage.implement.3.ai_judge',
      endTime: [1_778_777_215, 0],
      attributes: {
        'takt.provider.name': 'claude-sdk',
        'takt.model.name': 'claude-sonnet-4',
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
        'takt.phase.execution_id': 'implement:3:1:1',
        'takt.judge.stage': 3,
        'takt.judge.method': 'ai_judge',
        'takt.judge.status': 'done',
        'gen_ai.usage.input_tokens': 5,
        'gen_ai.usage.output_tokens': 4,
      },
    };

    expect(mapSpanEndToPhaseUsageEvent(span, context)).toEqual(expect.objectContaining({
      phase: 'phase3_fallback',
      phase_name: 'judge',
      phase_execution_id: 'implement:3:1:1',
      judge_stage: 3,
      judge_method: 'ai_judge',
      usage_missing: false,
      usage: {
        input_tokens: 5,
        output_tokens: 4,
        total_tokens: 9,
      },
    }));
  });

  it('skips phase 3 parent spans and spans missing required provider or step metadata', () => {
    expect(mapSpanEndToPhaseUsageEvent({
      name: 'phase.implement.judge',
      attributes: {
        'takt.provider.name': 'codex',
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
        'takt.phase.number': 3,
        'takt.phase.name': 'judge',
      },
    }, context)).toBeUndefined();

    expect(mapSpanEndToPhaseUsageEvent({
      name: 'phase.implement.execute',
      attributes: {
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
      },
    }, context)).toBeUndefined();
  });

  it('turns partial token attributes into usage_tokens_missing', () => {
    const record = mapSpanEndToPhaseUsageEvent({
      name: 'phase.implement.execute',
      attributes: {
        'takt.provider.name': 'mock',
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
        'gen_ai.usage.input_tokens': 5,
      },
    }, context);

    expect(record).toMatchObject({
      usage_missing: true,
      reason: 'usage_tokens_missing',
      usage: {},
    });
  });

  it('maps judge stage 1 (structured_output) into phase3_structured', () => {
    const span: SpanSnapshot = {
      name: 'judge_stage.implement.1.structured_output',
      endTime: [1_778_777_220, 0],
      attributes: {
        'takt.provider.name': 'claude-sdk',
        'takt.model.name': 'claude-sonnet-4',
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
        'takt.judge.stage': 1,
        'takt.judge.method': 'structured_output',
        'takt.judge.status': 'done',
        'gen_ai.usage.input_tokens': 10,
        'gen_ai.usage.output_tokens': 5,
        'gen_ai.usage.total_tokens': 15,
      },
    };

    expect(mapSpanEndToPhaseUsageEvent(span, context)).toMatchObject({
      phase: 'phase3_structured',
      phase_name: 'judge',
      judge_stage: 1,
      judge_method: 'structured_output',
      success: true,
      usage_missing: false,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
    });
  });

  it('maps judge stage 2 (phase3_tag) into phase3_tag', () => {
    const span: SpanSnapshot = {
      name: 'judge_stage.implement.2.phase3_tag',
      endTime: [1_778_777_225, 0],
      attributes: {
        'takt.provider.name': 'mock',
        'takt.model.name': 'mock-model',
        'takt.step.name': 'implement',
        'takt.step.type': 'arpeggio',
        'takt.judge.stage': 2,
        'takt.judge.method': 'phase3_tag',
        'takt.judge.status': 'done',
        'gen_ai.usage.input_tokens': 3,
        'gen_ai.usage.output_tokens': 2,
        'gen_ai.usage.total_tokens': 5,
      },
    };

    expect(mapSpanEndToPhaseUsageEvent(span, context)).toMatchObject({
      phase: 'phase3_tag',
      phase_name: 'judge',
      step_type: 'arpeggio',
      judge_stage: 2,
      judge_method: 'phase3_tag',
    });
  });

  it('returns undefined for spans with unrecognized names', () => {
    expect(mapSpanEndToPhaseUsageEvent({
      name: 'step.implement',
      attributes: {
        'takt.provider.name': 'mock',
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
      },
    }, context)).toBeUndefined();

    expect(mapSpanEndToPhaseUsageEvent({
      name: 'workflow.run',
      attributes: {},
    }, context)).toBeUndefined();

    expect(mapSpanEndToPhaseUsageEvent({
      name: '',
      attributes: {},
    }, context)).toBeUndefined();
  });

  it('preserves known usage_missing reasons verbatim', () => {
    const reasons = [
      'usage_not_available',
      'usage_tokens_missing',
      'usage_not_supported_by_provider',
    ] as const;

    for (const reason of reasons) {
      const span: SpanSnapshot = {
        name: 'phase.implement.execute',
        endTime: [1_778_777_230, 0],
        attributes: {
          'takt.provider.name': 'mock',
          'takt.step.name': 'implement',
          'takt.step.type': 'normal',
          'takt.phase.number': 1,
          'takt.phase.name': 'execute',
          'takt.phase.status': 'error',
          'takt.usage.missing': true,
          'takt.usage.missing_reason': reason,
        },
      };

      expect(mapSpanEndToPhaseUsageEvent(span, context)).toMatchObject({
        usage_missing: true,
        reason,
      });
    }
  });

  it('marks phase1 status as failed when takt.phase.status is not "done"', () => {
    const span: SpanSnapshot = {
      name: 'phase.implement.execute',
      endTime: [1_778_777_235, 0],
      attributes: {
        'takt.provider.name': 'mock',
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'error',
        'gen_ai.usage.input_tokens': 5,
        'gen_ai.usage.output_tokens': 3,
        'gen_ai.usage.total_tokens': 8,
      },
    };

    expect(mapSpanEndToPhaseUsageEvent(span, context)).toMatchObject({
      success: false,
      usage_missing: false,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    });
  });

  it('omits phase_execution_id when absent', () => {
    const span: SpanSnapshot = {
      name: 'phase.implement.execute',
      endTime: [1_778_777_240, 0],
      attributes: {
        'takt.provider.name': 'mock',
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
        'gen_ai.usage.input_tokens': 2,
        'gen_ai.usage.output_tokens': 1,
        'gen_ai.usage.total_tokens': 3,
      },
    };

    const result = mapSpanEndToPhaseUsageEvent(span, context);
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('phase_execution_id');
  });

  it('returns undefined when judge stage method is missing', () => {
    expect(mapSpanEndToPhaseUsageEvent({
      name: 'judge_stage.implement.1',
      attributes: {
        'takt.provider.name': 'mock',
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
        'takt.judge.stage': 1,
        // method deliberately omitted
        'takt.judge.status': 'done',
        'gen_ai.usage.input_tokens': 3,
        'gen_ai.usage.output_tokens': 2,
        'gen_ai.usage.total_tokens': 5,
      },
    }, context)).toBeUndefined();
  });

  it('returns undefined when step type is invalid', () => {
    expect(mapSpanEndToPhaseUsageEvent({
      name: 'phase.implement.execute',
      attributes: {
        'takt.provider.name': 'mock',
        'takt.step.name': 'implement',
        'takt.step.type': 'unknown_type',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
      },
    }, context)).toBeUndefined();
  });

  it('correctly handles nanoseconds in endTime when converting to ISO timestamp', () => {
    // 1 second = 1,000,000,000 ns; 500,000,000 ns = 500ms
    const span: SpanSnapshot = {
      name: 'phase.implement.execute',
      endTime: [1_000, 500_000_000],
      attributes: {
        'takt.provider.name': 'mock',
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
        'gen_ai.usage.input_tokens': 1,
        'gen_ai.usage.output_tokens': 1,
        'gen_ai.usage.total_tokens': 2,
      },
    };

    const result = mapSpanEndToPhaseUsageEvent(span, context);
    // 1000 seconds + 500 ms = Unix ms 1_000_500
    expect(result?.timestamp).toBe(new Date(1_000_500).toISOString());
  });

  it('produces a valid timestamp when endTime is absent', () => {
    const before = Date.now();
    const result = mapSpanEndToPhaseUsageEvent({
      name: 'phase.implement.execute',
      attributes: {
        'takt.provider.name': 'mock',
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
        'gen_ai.usage.input_tokens': 1,
        'gen_ai.usage.output_tokens': 1,
        'gen_ai.usage.total_tokens': 2,
      },
    }, context);
    const after = Date.now();

    expect(result).toBeDefined();
    const ts = new Date(result!.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
