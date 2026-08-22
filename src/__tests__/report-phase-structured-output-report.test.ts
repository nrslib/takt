/**
 * Regression: `structured_output` と `output_contracts.report` を併用した step で、
 * report file が Phase 2 の Markdown ではなく Phase 1 の structured output JSON に
 * なる不具合（issue #1242）。
 *
 * step の structured_output は Phase 1 の遷移判定用であり、report phase の成果物では
 * ない。Phase 2 に outputSchema を渡すと provider はスキーマどおりの JSON を本文として
 * 返し、それがそのまま report file になる。ここでは本番の OptionsBuilder が組み立てた
 * options で report phase を回し、スキーマ順守 provider を模した runAgent double で
 * その退行を捕まえる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { runReportPhase } from '../core/workflow/phase-runner.js';
import type { WorkflowState, WorkflowStep } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';

const REPORT_DIR_REL = join('.takt', 'runs', 'sample-run', 'reports');
const PHASE1_STRUCTURED_JSON = '{"status":"COMPLETE"}';
const PHASE2_MARKDOWN = '# Research Result (v2)\n\n## Summary\n\nStructured output plus Markdown report.';

function createStep(): WorkflowStep {
  return {
    name: 'researcher',
    persona: 'researcher',
    personaDisplayName: 'Researcher',
    instruction: 'Run the reproduction test',
    passPreviousResponse: false,
    outputContracts: [{ name: 'repro.md' }],
    structuredOutput: {
      schemaRef: 'researcher-status',
      schema: {
        type: 'object',
        properties: { status: { type: 'string' } },
        required: ['status'],
        additionalProperties: false,
      },
    },
  };
}

function createState(): WorkflowState {
  return {
    workflowName: 'structured-report-repro',
    currentStep: 'researcher',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map([['["researcher","claude"]', 'phase1-session']]),
    stepIterations: new Map(),
    status: 'running',
  };
}

function createBuilder(cwd: string, step: WorkflowStep): OptionsBuilder {
  const engineOptions: WorkflowEngineOptions = {
    projectCwd: cwd,
    provider: 'claude',
    structuredCaller: {
      evaluateCondition: vi.fn(),
      judgeStatus: vi.fn(),
      decomposeTask: vi.fn(),
      requestMoreParts: vi.fn(),
    },
  } as unknown as WorkflowEngineOptions;

  return new OptionsBuilder(
    engineOptions,
    () => cwd,
    () => cwd,
    () => undefined,
    () => REPORT_DIR_REL,
    () => 'en',
    () => [{ name: step.name }],
    () => 'structured-report-repro',
    () => 'reproduction workflow',
  );
}

/** スキーマを要求されたらスキーマどおりの JSON を本文として返す実 provider の模写。 */
function stubSchemaHonoringProvider(): void {
  vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
    options?.onPromptResolved?.({
      systemPrompt: typeof persona === 'string' ? persona : '',
      userInstruction: instruction,
    });
    const requestedSchema = options?.outputSchema !== undefined;
    return {
      persona: 'researcher',
      status: 'done',
      content: requestedSchema ? PHASE1_STRUCTURED_JSON : PHASE2_MARKDOWN,
      timestamp: new Date('2026-08-08T00:00:00Z'),
      sessionId: 'phase1-session',
      ...(requestedSchema ? { structuredOutput: { status: 'COMPLETE' } } : {}),
    };
  });
}

describe('report phase with structured_output', () => {
  let cwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    cwd = mkdtempSync(join(tmpdir(), 'takt-structured-report-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('writes the Phase 2 Markdown report instead of the Phase 1 structured output', async () => {
    // Given: structured_output と report を併用する step
    const step = createStep();
    const builder = createBuilder(cwd, step);
    stubSchemaHonoringProvider();
    const ctx = builder.buildPhaseRunnerContext(
      step,
      createState(),
      PHASE1_STRUCTURED_JSON,
      () => {},
    );

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    const reportContent = readFileSync(join(cwd, REPORT_DIR_REL, 'repro.md'), 'utf-8');
    expect(reportContent).toBe(PHASE2_MARKDOWN);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.outputSchema).toBeUndefined();
  });
});
