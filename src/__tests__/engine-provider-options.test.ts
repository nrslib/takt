import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/piece/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn(),
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { PieceEngine } from '../core/piece/index.js';
import { runAgent } from '../agents/runner.js';
import {
  applyDefaultMocks,
  cleanupPieceEngine,
  createTestTmpDir,
  makeMovement,
  makeResponse,
  makeRule,
  mockDetectMatchedRuleSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';
import type { PieceConfig } from '../core/models/index.js';

describe('PieceEngine provider_options resolution', () => {
  let tmpDir: string;
  let engine: PieceEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine) {
      cleanupPieceEngine(engine);
      engine = undefined;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should merge provider_options in order: global < piece/movement < project', async () => {
    const movement = makeMovement('implement', {
      providerOptions: {
        codex: { networkAccess: false },
        claude: { sandbox: { excludedCommands: ['./gradlew'] } },
      },
      rules: [makeRule('done', 'COMPLETE')],
    });

    const config: PieceConfig = {
      name: 'provider-options-priority',
      movements: [movement],
      initialMovement: 'implement',
      maxMovements: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: movement.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'claude',
      providerOptionsSource: 'project',
      providerOptions: {
        codex: { networkAccess: true },
        claude: { sandbox: { allowUnsandboxedCommands: false } },
        opencode: { networkAccess: true },
      },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: true },
      opencode: { networkAccess: true },
      claude: {
        sandbox: {
          allowUnsandboxedCommands: false,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });

  it('should pass global provider_options when project and movement options are absent', async () => {
    const movement = makeMovement('implement', {
      rules: [makeRule('done', 'COMPLETE')],
    });

    const config: PieceConfig = {
      name: 'provider-options-global-only',
      movements: [movement],
      initialMovement: 'implement',
      maxMovements: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: movement.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'claude',
      providerOptions: {
        codex: { networkAccess: true },
      },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });
});
