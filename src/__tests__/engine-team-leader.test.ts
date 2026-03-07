import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { runAgent } from '../agents/runner.js';
import { detectMatchedRule } from '../core/piece/evaluation/index.js';
import { PieceEngine } from '../core/piece/engine/PieceEngine.js';
import { makeMovement, makeRule, makeResponse, createTestTmpDir, applyDefaultMocks } from './engine-test-helpers.js';
import type { PieceConfig } from '../core/models/index.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/piece/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

function buildTeamLeaderConfig(): PieceConfig {
  return {
    name: 'team-leader-piece',
    initialMovement: 'implement',
    maxMovements: 5,
    movements: [
      makeMovement('implement', {
        instruction: 'Task: {task}',
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxParts: 3,
          refillThreshold: 0,
          timeoutMs: 10000,
          partPersona: '../personas/coder.md',
          partAllowedTools: ['Read', 'Edit', 'Write'],
          partEdit: true,
          partPermissionMode: 'edit',
        },
        rules: [makeRule('done', 'COMPLETE')],
      }),
    ],
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

describe('PieceEngine Integration: TeamLeaderRunner', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('team leaderが分解したパートを並列実行し集約する', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new PieceEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        content: [
          '```json',
          '[{"id":"part-1","title":"API","instruction":"Implement API"},{"id":"part-2","title":"Test","instruction":"Add tests"}]',
          '```',
        ].join('\n'),
      }),
      makeResponse({ persona: 'coder', content: 'API done' }),
      makeResponse({ persona: 'coder', content: 'Tests done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'enough', parts: [] },
      }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(4);
    const output = state.movementOutputs.get('implement');
    expect(output).toBeDefined();
    expect(output!.content).toContain('## decomposition');
    expect(output!.content).toContain('## part-1: API');
    expect(output!.content).toContain('API done');
    expect(output!.content).toContain('## part-2: Test');
    expect(output!.content).toContain('Tests done');
  });

  it('全パートが失敗した場合はムーブメント失敗として中断する', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new PieceEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        content: [
          '```json',
          '[{"id":"part-1","title":"API","instruction":"Implement API"},{"id":"part-2","title":"Test","instruction":"Add tests"}]',
          '```',
        ].join('\n'),
      }),
      makeResponse({ persona: 'coder', status: 'error', error: 'api failed' }),
      makeResponse({ persona: 'coder', status: 'error', error: 'test failed' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'stop', parts: [] },
      }),
    );

    const state = await engine.run();

    expect(state.status).toBe('aborted');
  });

  it('一部パートが失敗しても成功パートがあれば集約結果は完了する', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new PieceEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        content: [
          '```json',
          '[{"id":"part-1","title":"API","instruction":"Implement API"},{"id":"part-2","title":"Test","instruction":"Add tests"}]',
          '```',
        ].join('\n'),
      }),
      makeResponse({ persona: 'coder', content: 'API done' }),
      makeResponse({ persona: 'coder', status: 'error', error: 'test failed' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'stop', parts: [] },
      }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const output = state.movementOutputs.get('implement');
    expect(output).toBeDefined();
    expect(output!.content).toContain('## part-1: API');
    expect(output!.content).toContain('API done');
    expect(output!.content).toContain('## part-2: Test');
    expect(output!.content).toContain('[ERROR] test failed');
  });

  it('パート失敗時にerrorがなくてもcontentの詳細をエラー表示に使う', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new PieceEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        content: [
          '```json',
          '[{"id":"part-1","title":"API","instruction":"Implement API"},{"id":"part-2","title":"Test","instruction":"Add tests"}]',
          '```',
        ].join('\n'),
      }),
      makeResponse({ persona: 'coder', status: 'error', content: 'api failed from content' }),
      makeResponse({ persona: 'coder', content: 'Tests done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'stop', parts: [] },
      }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const output = state.movementOutputs.get('implement');
    expect(output).toBeDefined();
    expect(output!.content).toContain('[ERROR] api failed from content');
  });

  it('結果に応じて追加パートを生成して実行する', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new PieceEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: 'part-1', title: 'API', instruction: 'Implement API', timeout_ms: null },
            { id: 'part-2', title: 'Test', instruction: 'Add tests', timeout_ms: null },
          ],
        },
      }),
      makeResponse({ persona: 'coder', content: 'API done' }),
      makeResponse({ persona: 'coder', content: 'Tests done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          done: false,
          reasoning: 'Need docs',
          parts: [
            { id: 'part-3', title: 'Docs', instruction: 'Write docs', timeout_ms: null },
          ],
        },
      }),
      makeResponse({ persona: 'coder', content: 'Docs done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          done: true,
          reasoning: 'Enough',
          parts: [],
        },
      }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(6);
    const output = state.movementOutputs.get('implement');
    expect(output).toBeDefined();
    expect(output!.content).toContain('## part-3: Docs');
    expect(output!.content).toContain('Docs done');
  });

  it('team leader の phase:start には分解実行時の実 instruction を記録する', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new PieceEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir });
    const phaseStarts: string[] = [];
    engine.on('phase:start', (step, phase, phaseName, instruction) => {
      if (step.name !== 'implement' || phase !== 1 || phaseName !== 'execute') return;
      phaseStarts.push(instruction);
    });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API', timeout_ms: null }],
        },
      }),
      makeResponse({ persona: 'coder', content: 'API done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'enough', parts: [] },
      }),
    );
    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(phaseStarts.length).toBeGreaterThan(0);
    expect(phaseStarts[0]).toContain('This is decomposition-only planning. Do not execute the task.');
  });

});
