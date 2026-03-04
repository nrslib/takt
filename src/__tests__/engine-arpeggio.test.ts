/**
 * Integration tests for arpeggio movement execution via PieceEngine.
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

vi.mock('../core/piece/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
  evaluateAggregateConditions: vi.fn(),
}));

vi.mock('../core/piece/phase-runner.js', () => ({
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
import { detectMatchedRule } from '../core/piece/evaluation/index.js';
import { PieceEngine } from '../core/piece/engine/PieceEngine.js';
import type { PieceConfig, PieceMovement, AgentResponse, ArpeggioMovementConfig } from '../core/models/index.js';
import type { PieceEngineOptions } from '../core/piece/types.js';
import {
  makeResponse,
  makeMovement,
  makeRule,
  createTestTmpDir,
  cleanupPieceEngine,
} from './engine-test-helpers.js';
import type { RuleMatch } from '../core/piece/index.js';

function createArpeggioTestDir(): { tmpDir: string; csvPath: string; templatePath: string } {
  const tmpDir = createTestTmpDir();
  const csvPath = join(tmpDir, 'data.csv');
  const templatePath = join(tmpDir, 'template.md');

  writeFileSync(csvPath, 'name,task\nAlice,review\nBob,implement\nCharlie,test', 'utf-8');
  writeFileSync(templatePath, 'Process {line:1}', 'utf-8');

  return { tmpDir, csvPath, templatePath };
}

function createArpeggioConfig(csvPath: string, templatePath: string, overrides: Partial<ArpeggioMovementConfig> = {}): ArpeggioMovementConfig {
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

function buildArpeggioPieceConfig(arpeggioConfig: ArpeggioMovementConfig, tmpDir: string): PieceConfig {
  return {
    name: 'test-arpeggio',
    description: 'Test arpeggio piece',
    maxMovements: 10,
    initialMovement: 'process',
    movements: [
      {
        ...makeMovement('process', {
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

function createEngineOptions(tmpDir: string): PieceEngineOptions {
  return {
    projectCwd: tmpDir,
    reportDirName: 'test-report-dir',
    detectRuleIndex: () => 0,
    callAiJudge: async () => 0,
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
  let engine: PieceEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(detectMatchedRule).mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (engine) {
      cleanupPieceEngine(engine);
      engine = undefined;
    }
  });

  it('should process CSV data and merge results', async () => {
    const { tmpDir, csvPath, templatePath } = createArpeggioTestDir();
    const arpeggioConfig = createArpeggioConfig(csvPath, templatePath);
    const config = buildArpeggioPieceConfig(arpeggioConfig, tmpDir);

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

    engine = new PieceEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir));
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(mockAgent).toHaveBeenCalledTimes(3);

    // Verify merged content in movement output
    const output = state.movementOutputs.get('process');
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
    const config = buildArpeggioPieceConfig(arpeggioConfig, tmpDir);

    const mockAgent = vi.mocked(runAgent);
    mockRunAgentWithPrompt(
      makeResponse({ content: 'Batch 0 result' }),
      makeResponse({ content: 'Batch 1 result' }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({
      index: 0,
      method: 'phase1_tag',
    });

    engine = new PieceEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir));
    const state = await engine.run();

    expect(state.status).toBe('completed');
    // 4 rows / batch_size 2 = 2 batches
    expect(mockAgent).toHaveBeenCalledTimes(2);
  });

  it('should abort when a batch fails and retries are exhausted', async () => {
    const { tmpDir, csvPath, templatePath } = createArpeggioTestDir();
    const arpeggioConfig = createArpeggioConfig(csvPath, templatePath, {
      maxRetries: 1,
      retryDelayMs: 0,
    });
    const config = buildArpeggioPieceConfig(arpeggioConfig, tmpDir);

    const mockAgent = vi.mocked(runAgent);
    mockRunAgentWithPrompt(
      makeResponse({ content: 'OK' }),
      makeResponse({ status: 'error', error: 'fail1' }),
      makeResponse({ status: 'error', error: 'fail2' }),
      makeResponse({ content: 'OK' }),
    );

    engine = new PieceEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir));
    const state = await engine.run();

    expect(state.status).toBe('aborted');
  });

  it('should write output file when output_path is configured', async () => {
    const { tmpDir, csvPath, templatePath } = createArpeggioTestDir();
    const outputPath = join(tmpDir, 'output.txt');
    const arpeggioConfig = createArpeggioConfig(csvPath, templatePath, { outputPath });
    const config = buildArpeggioPieceConfig(arpeggioConfig, tmpDir);

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

    engine = new PieceEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir));
    await engine.run();

    const { readFileSync } = await import('node:fs');
    const outputContent = readFileSync(outputPath, 'utf-8');
    expect(outputContent).toBe('Result A\nResult B\nResult C');
  });

  it('should handle concurrency > 1', async () => {
    const { tmpDir, csvPath, templatePath } = createArpeggioTestDir();
    const arpeggioConfig = createArpeggioConfig(csvPath, templatePath, { concurrency: 3 });
    const config = buildArpeggioPieceConfig(arpeggioConfig, tmpDir);

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

    engine = new PieceEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir));
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(mockAgent).toHaveBeenCalledTimes(3);
  });

  it('should record resolved prompt in phase:start for arpeggio batches', async () => {
    const { tmpDir, csvPath, templatePath } = createArpeggioTestDir();
    const arpeggioConfig = createArpeggioConfig(csvPath, templatePath, { concurrency: 2 });
    const config = buildArpeggioPieceConfig(arpeggioConfig, tmpDir);
    const phaseStarts: string[] = [];

    mockRunAgentWithPrompt(
      makeResponse({ content: 'A' }),
      makeResponse({ content: 'B' }),
      makeResponse({ content: 'C' }),
    );
    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    engine = new PieceEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir));
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
    const config = buildArpeggioPieceConfig(arpeggioConfig, tmpDir);
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

    engine = new PieceEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir));
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
