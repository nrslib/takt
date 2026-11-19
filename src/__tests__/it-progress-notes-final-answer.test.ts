import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThreadOptions } from '@openai/codex-sdk';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
import { ProviderNeutralStructuredCaller } from '../agents/structured-caller.js';
import type { ArpeggioStepConfig, ArpeggioWorkflowStep, WorkflowConfig } from '../core/models/index.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import { cleanupWorkflowEngine, createTestTmpDir, makeRule, makeStep } from './engine-test-helpers.js';

vi.mock('../infra/managed-providers/loader.js', () => import('./helpers/managed-sdk.js'));
vi.mock('../infra/codex/skill-config.js', () => ({ buildCodexSkillConfig: () => ({}) }));
vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return { ...actual, RuleEvaluator: MockRuleEvaluator };
});
vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: '', method: 'auto_select' }),
}));

const { inputs } = vi.hoisted(() => ({ inputs: [] as string[] }));

function finalAnswerFor(input: string): string {
  const name = /name: (\w+)/.exec(input)?.[1];
  return name === undefined ? 'Summary of both rows' : `Processed ${name}`;
}

// Codex reports every agent message of a turn; only the last one is the answer.
vi.mock('@openai/codex-sdk', () => {
  function createThread(_options: ThreadOptions, sessionId?: string) {
    const id = sessionId ?? `thread-${inputs.length + 1}`;
    return {
      id,
      runStreamed: async (input: unknown) => {
        expect(input).toEqual(expect.any(String));
        const envelope: unknown = JSON.parse(input as string);
        expect(envelope).toEqual({
          taktCurrentInstructions: expect.any(String),
          userInstruction: expect.any(String),
        });
        const { userInstruction } = envelope as { userInstruction: string };
        inputs.push(userInstruction);
        const turn = inputs.length;
        return {
          events: (async function* () {
            yield { type: 'thread.started', thread_id: id };
            yield { type: 'item.completed', item: { id: `note-${turn}`, type: 'agent_message', text: `Progress note ${turn}: checked the row. Remaining: answer.` } };
            yield { type: 'item.completed', item: { id: `tool-${turn}`, type: 'command_execution', command: 'cat row', aggregated_output: 'row', exit_code: 0, status: 'completed' } };
            yield { type: 'item.completed', item: { id: `answer-${turn}`, type: 'agent_message', text: finalAnswerFor(userInstruction) } };
            yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
          })(),
        };
      },
    };
  }
  return {
    Codex: class {
      startThread(options: ThreadOptions) { return createThread(options); }
      resumeThread(sessionId: string, options: ThreadOptions) { return createThread(options, sessionId); }
    },
  };
});

function readNotes(directory: string): string {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.includes('progress-notes') && path.endsWith('.log'))
    .map((path) => readFileSync(join(directory, path), 'utf8'))
    .join('\n');
}

describe('progress notes stay out of step results', () => {
  let cwd: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    cwd = createTestTmpDir();
    inputs.length = 0;
    mockRuleEvaluation.mockReset();
    mockRuleEvaluation.mockReturnValue({ index: 0, method: 'phase3_tag' });
  });

  afterEach(() => {
    if (engine) cleanupWorkflowEngine(engine);
    engine = undefined;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('records intermediate notes while arpeggio output and the next previous_response contain only final answers', async () => {
    const csvPath = join(cwd, 'rows.csv');
    const templatePath = join(cwd, 'template.md');
    const outputPath = join(cwd, 'merged.md');
    writeFileSync(csvPath, 'name,task\nAlice,review\nBob,implement', 'utf8');
    writeFileSync(templatePath, 'Process {line:1}', 'utf8');
    const arpeggio: ArpeggioStepConfig = {
      source: 'csv', sourcePath: csvPath, batchSize: 1, concurrency: 1, templatePath,
      merge: { strategy: 'concat' }, outputPath, maxRetries: 0, retryDelayMs: 0,
    };
    const process: ArpeggioWorkflowStep = {
      kind: 'agent', name: 'process', personaDisplayName: 'process', instruction: 'Process rows',
      passPreviousResponse: false, rules: [makeRule('done', 'summarize')], arpeggio,
    };
    const config: WorkflowConfig = {
      name: 'notes-final-answer',
      maxSteps: 5,
      initialStep: 'process',
      steps: [
        process,
        makeStep('summarize', {
          persona: undefined, edit: false, passPreviousResponse: true,
          instruction: 'Summarize:\n{previous_response}', rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    engine = new WorkflowEngine(config, cwd, 'Process rows', {
      projectCwd: cwd, provider: 'codex', language: 'en', structuredCaller: new ProviderNeutralStructuredCaller(),
    });
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(inputs).toHaveLength(3);
    expect(readFileSync(outputPath, 'utf8')).toBe('Processed Alice\nProcessed Bob');
    expect(state.stepOutputs.get('process')?.content).toBe('Processed Alice\nProcessed Bob');
    const summarizeInput = inputs[2]!;
    expect(summarizeInput).toContain('Processed Alice\nProcessed Bob');
    expect(summarizeInput).not.toMatch(/Progress note \d/);
    expect(state.stepOutputs.get('summarize')?.content).toBe('Summary of both rows');
    const notes = readNotes(join(cwd, '.takt'));
    for (const turn of [1, 2, 3]) {
      expect(notes).toContain(`Progress note ${turn}: checked the row.`);
    }
  });
});
