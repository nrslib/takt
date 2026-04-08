/**
 * Integration tests for arpeggio step execution via WorkflowEngine.
 *
 * Tests the full pipeline: CSV → template expansion → LLM → merge → rule evaluation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Mock external dependencies before importing
vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
  evaluateAggregateConditions: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async () => {
  const actual = await vi.importActual<typeof import('../shared/utils/index.js')>('../shared/utils/index.js');
  return {
    ...actual,
    generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  };
});

import { runAgent } from '../agents/runner.js';
import { detectMatchedRule } from '../core/workflow/evaluation/index.js';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
import { DefaultStructuredCaller } from '../agents/structured-caller.js';
import type { WorkflowConfig, WorkflowStep, AgentResponse, ArpeggioStepConfig } from '../core/models/index.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  createTestTmpDir,
  cleanupWorkflowEngine,
} from './engine-test-helpers.js';
import type { RuleMatch } from '../core/workflow/index.js';

function createArpeggioTestDir(): { tmpDir: string; csvPath: string; templatePath: string } {
  const tmpDir = createTestTmpDir();
  const csvPath = join(tmpDir, 'data.csv');
  const templatePath = join(tmpDir, 'template.md');

  writeFileSync(csvPath, 'name,task\nAlice,review\nBob,implement\nCharlie,test', 'utf-8');
  writeFileSync(templatePath, 'Process {line:1}', 'utf-8');

  return { tmpDir, csvPath, templatePath };
}

function createArpeggioConfig(csvPath: string, templatePath: string, overrides: Partial<ArpeggioStepConfig> = {}): ArpeggioStepConfig {
  return {
    source: 'csv',
    sourcePath: csvPath,
    batchSize: 1,
    concurrency: 1,
    templatePath,
    merge: { strategy: 'concat' },
    maxRetries: 0,
    retryDelayMs: 0,
    ...overrides,
  };
}

function buildArpeggioWorkflowConfig(arpeggioConfig: ArpeggioStepConfig, tmpDir: string): WorkflowConfig {
  return {
    name: 'test-arpeggio',
    description: 'Test arpeggio workflow',
    maxSteps: 10,
    initialStep: 'process',
    steps: [
      {
        ...makeStep('process', {
          rules: [
            makeRule('Processing complete', 'COMPLETE'),
            makeRule('Processing failed', 'ABORT'),
          ],
        }),
        arpeggio: arpeggioConfig,
      },
    ],
  };
}

function createEngineOptions(tmpDir: string): WorkflowEngineOptions {
  return {
    projectCwd: tmpDir,
    reportDirName: 'test-report-dir',
    detectRuleIndex: () => 0,
    structuredCaller: new DefaultStructuredCaller(),
  };
}

function mockRunAgentWithPrompt(...responses: ReturnType<typeof makeResponse>[]): void {
  const mock = vi.mocked(runAgent);
  for (const response of responses) {
    mock.mockImplementationOnce(async (persona, instruction, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      return response;
    });
  }
}

describe('ArpeggioRunner integration', () => {
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(detectMatchedRule).mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (engine) {
      cleanupWorkflowEngine(engine);
      engine = undefined;
    }
  });

  it('should process CSV data and merge results', async () => {
    const { tmpDir, csvPath, templatePath } = createArpeggioTestDir();
    const arpeggioConfig = createArpeggioConfig(csvPath, templatePath);
    const config = buildArpeggioWorkflowConfig(arpeggioConfig, tmpDir);

    // Mock agent to return batch-specific responses
    const mockAgent = vi.mocked(runAgent);
    mockRunAgentWithPrompt(
      makeResponse({ content: 'Processed Alice' }),
      makeResponse({ content: 'Processed Bob' }),
      makeResponse({ content: 'Processed Charlie' }),
    );

    // Mock rule detection for the merged result
    vi.mocked(detectMatchedRule).mockResolvedValueOnce({
      index: 0,
      method: 'phase1_tag',
    });

    engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir));
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(mockAgent).toHaveBeenCalledTimes(3);

    // Verify merged content in step output
    const output = state.stepOutputs.get('process');
    expect(output).toBeDefined();
    expect(output!.content).toBe('Processed Alice\nProcessed Bob\nProcessed Charlie');

    const previousDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'context', 'previous_responses');
    const previousFiles = readdirSync(previousDir);
    expect(state.previousResponseSourcePath).toMatch(/^\.takt\/runs\/test-report-dir\/context\/previous_responses\/process\.1\.\d{8}T\d{6}Z\.md$/);
    expect(previousFiles).toContain('latest.md');
    expect(readFileSync(join(previousDir, 'latest.md'), 'utf-8')).toBe('Processed Alice\nProcessed Bob\nProcessed Charlie');
  });

  it('should handle batch_size > 1', async () => {
    const tmpDir = createTestTmpDir();
    const csvPath = join(tmpDir, 'data.csv');
    const templatePath = join(tmpDir, 'batch-template.md');
    // 4 rows so batch_size=2 gives exactly 2 batches with 2 rows each
    writeFileSync(csvPath, 'name,task\nAlice,review\nBob,implement\nCharlie,test\nDave,deploy', 'utf-8');
    writeFileSync(templatePath, 'Row1: {line:1}\nRow2: {line:2}', 'utf-8');

    const arpeggioConfig = createArpeggioConfig(csvPath, templatePath, { batchSize: 2 });
    const config = buildArpeggioWorkflowConfig(arpeggioConfig, tmpDir);

    const mockAgent = vi.mocked(runAgent);
    mockRunAgentWithPrompt(
      makeResponse({ content: 'Batch 0 result' }),
      makeResponse({ content: 'Batch 1 result' }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({
      index: 0,
      method: 'phase1_tag',
    });

    engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir));
    const state = await engine.run();

    expect(state.status).toBe('completed');
    // 4 rows / batch_size 2 = 2 batches
    expect(mockAgent).toHaveBeenCalledTimes(2);
  });

  it('should pass resolved provider to arpeggio rule evaluation', async () => {
    const { tmpDir, csvPath, templatePath } = createArpeggioTestDir();
    const arpeggioConfig = createArpeggioConfig(csvPath, templatePath);
    const config = buildArpeggioWorkflowConfig(arpeggioConfig, tmpDir);
    config.steps[0]!.personaDisplayName = 'coder';

    mockRunAgentWithPrompt(
      makeResponse({ content: 'Processed Alice' }),
      makeResponse({ content: 'Processed Bob' }),
      makeResponse({ content: 'Processed Charlie' }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({
      index: 0,
      method: 'phase1_tag',
    });

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      ...createEngineOptions(tmpDir),
      provider: 'claude',
      personaProviders: { coder: { provider: 'cursor' } },
    });
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(detectMatchedRule).mock.calls[0]?.[3].provider).toBe('cursor');
  });

  it('should abort when a batch fails and retries are exhausted', async () => {
    const { tmpDir, csvPath, templatePath } = createArpeggioTestDir();
    const arpeggioConfig = createArpeggioConfig(csvPath, templatePath, {
      maxRetries: 1,
      retryDelayMs: 0,
    });
    const config = buildArpeggioWorkflowConfig(arpeggioConfig, tmpDir);

    const mockAgent = vi.mocked(runAgent);
    mockRunAgentWithPrompt(
      makeResponse({ content: 'OK' }),
      makeResponse({ status: 'error', error: 'fail1' }),
      makeResponse({ status: 'error', error: 'fail2' }),
      makeResponse({ content: 'OK' }),
    );

    engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir));
    const state = await engine.run();

    expect(state.status).toBe('aborted');
  });

  it('should write output file when output_path is configured', async () => {
    const { tmpDir, csvPath, templatePath } = createArpeggioTestDir();
    const outputPath = join(tmpDir, 'output.txt');
    const arpeggioConfig = createArpeggioConfig(csvPath, templatePath, { outputPath });
    const config = buildArpeggioWorkflowConfig(arpeggioConfig, tmpDir);

    const mockAgent = vi.mocked(runAgent);
    mockRunAgentWithPrompt(
      makeResponse({ content: 'Result A' }),
      makeResponse({ content: 'Result B' }),
      makeResponse({ content: 'Result C' }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({
      index: 0,
      method: 'phase1_tag',
    });

    engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir));
    await engine.run();

    const { readFileSync } = await import('node:fs');
    const outputContent = readFileSync(outputPath, 'utf-8');
    expect(outputContent).toBe('Result A\nResult B\nResult C');
  });

  it('should handle concurrency > 1', async () => {
    const { tmpDir, csvPath, templatePath } = createArpeggioTestDir();
    const arpeggioConfig = createArpeggioConfig(csvPath, templatePath, { concurrency: 3 });
    const config = buildArpeggioWorkflowConfig(arpeggioConfig, tmpDir);

    const mockAgent = vi.mocked(runAgent);
    mockRunAgentWithPrompt(
      makeResponse({ content: 'A' }),
      makeResponse({ content: 'B' }),
      makeResponse({ content: 'C' }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({
      index: 0,
      method: 'phase1_tag',
    });

    engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir));
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(mockAgent).toHaveBeenCalledTimes(3);
  });

  it('should record resolved prompt in phase:start for arpeggio batches', async () => {
    const { tmpDir, csvPath, templatePath } = createArpeggioTestDir();
    const arpeggioConfig = createArpeggioConfig(csvPath, templatePath, { concurrency: 2 });
    const config = buildArpeggioWorkflowConfig(arpeggioConfig, tmpDir);
    const phaseStarts: string[] = [];

    mockRunAgentWithPrompt(
      makeResponse({ content: 'A' }),
      makeResponse({ content: 'B' }),
      makeResponse({ content: 'C' }),
    );
    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir));
    engine.on('phase:start', (step, phase, phaseName, instruction) => {
      if (step.name !== 'process' || phase !== 1 || phaseName !== 'execute') return;
      phaseStarts.push(instruction);
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(phaseStarts.length).toBe(3);
    expect(phaseStarts.every((instruction) => !instruction.startsWith('[Arpeggio batch'))).toBe(true);
    expect(phaseStarts.some((instruction) => instruction.includes('Process '))).toBe(true);
  });

  it('should keep phaseExecutionId bindings correct when completion order is reversed', async () => {
    const { tmpDir, csvPath, templatePath } = createArpeggioTestDir();
    const arpeggioConfig = createArpeggioConfig(csvPath, templatePath, { concurrency: 2 });
    const config = buildArpeggioWorkflowConfig(arpeggioConfig, tmpDir);
    const phaseStartsByExecutionId = new Map<string, string>();
    const phaseCompletions: Array<{ phaseExecutionId?: string; content: string }> = [];

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      if (instruction.includes('Alice')) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return makeResponse({ content: 'Result Alice' });
      }
      if (instruction.includes('Bob')) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return makeResponse({ content: 'Result Bob' });
      }
      return makeResponse({ content: 'Result Charlie' });
    });
    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir));
    engine.on('phase:start', (step, phase, phaseName, instruction, _promptParts, phaseExecutionId) => {
      if (step.name !== 'process' || phase !== 1 || phaseName !== 'execute' || !phaseExecutionId) return;
      phaseStartsByExecutionId.set(phaseExecutionId, instruction);
    });
    engine.on('phase:complete', (step, phase, phaseName, content, _status, _error, phaseExecutionId) => {
      if (step.name !== 'process' || phase !== 1 || phaseName !== 'execute') return;
      phaseCompletions.push({ phaseExecutionId, content });
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(phaseCompletions).toHaveLength(3);
    expect(new Set(phaseCompletions.map((entry) => entry.phaseExecutionId)).size).toBe(3);
    expect(phaseCompletions.map((entry) => entry.content).sort()).toEqual([
      'Result Alice',
      'Result Bob',
      'Result Charlie',
    ]);
    for (const completion of phaseCompletions) {
      const instruction = completion.phaseExecutionId
        ? phaseStartsByExecutionId.get(completion.phaseExecutionId)
        : undefined;
      expect(instruction).toBeDefined();
      if (completion.content === 'Result Alice') {
        expect(instruction).toContain('Alice');
      } else if (completion.content === 'Result Bob') {
        expect(instruction).toContain('Bob');
      } else {
        expect(instruction).toContain('Charlie');
      }
    }
  });

});
