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
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(''),
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
        instructionTemplate: 'Task: {task}',
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxParts: 3,
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

    vi.mocked(runAgent)
      .mockResolvedValueOnce(makeResponse({
        persona: 'team-leader',
        content: [
          '```json',
          '[{"id":"part-1","title":"API","instruction":"Implement API"},{"id":"part-2","title":"Test","instruction":"Add tests"}]',
          '```',
        ].join('\n'),
      }))
      .mockResolvedValueOnce(makeResponse({ persona: 'coder', content: 'API done' }))
      .mockResolvedValueOnce(makeResponse({ persona: 'coder', content: 'Tests done' }));

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(3);
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

    vi.mocked(runAgent)
      .mockResolvedValueOnce(makeResponse({
        persona: 'team-leader',
        content: [
          '```json',
          '[{"id":"part-1","title":"API","instruction":"Implement API"},{"id":"part-2","title":"Test","instruction":"Add tests"}]',
          '```',
        ].join('\n'),
      }))
      .mockResolvedValueOnce(makeResponse({ persona: 'coder', status: 'error', error: 'api failed' }))
      .mockResolvedValueOnce(makeResponse({ persona: 'coder', status: 'error', error: 'test failed' }));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
  });

  it('一部パートが失敗しても成功パートがあれば集約結果は完了する', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new PieceEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir });

    vi.mocked(runAgent)
      .mockResolvedValueOnce(makeResponse({
        persona: 'team-leader',
        content: [
          '```json',
          '[{"id":"part-1","title":"API","instruction":"Implement API"},{"id":"part-2","title":"Test","instruction":"Add tests"}]',
          '```',
        ].join('\n'),
      }))
      .mockResolvedValueOnce(makeResponse({ persona: 'coder', content: 'API done' }))
      .mockResolvedValueOnce(makeResponse({ persona: 'coder', status: 'error', error: 'test failed' }));

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

    vi.mocked(runAgent)
      .mockResolvedValueOnce(makeResponse({
        persona: 'team-leader',
        content: [
          '```json',
          '[{"id":"part-1","title":"API","instruction":"Implement API"},{"id":"part-2","title":"Test","instruction":"Add tests"}]',
          '```',
        ].join('\n'),
      }))
      .mockResolvedValueOnce(makeResponse({ persona: 'coder', status: 'error', content: 'api failed from content' }))
      .mockResolvedValueOnce(makeResponse({ persona: 'coder', content: 'Tests done' }));

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const output = state.movementOutputs.get('implement');
    expect(output).toBeDefined();
    expect(output!.content).toContain('[ERROR] api failed from content');
  });
});
