import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

const {
  mockLoadWorkflowByIdentifier,
  mockResolveWorkflowConfigValue,
  mockResolveWorkflowConfigValues,
  mockResolveConfigValueWithSource,
  mockHeader,
  mockInfo,
  mockError,
  mockBlankLine,
  mockInstructionBuild,
  mockReportBuild,
  mockJudgmentBuild,
} = vi.hoisted(() => ({
  mockLoadWorkflowByIdentifier: vi.fn(),
  mockResolveWorkflowConfigValue: vi.fn(),
  mockResolveWorkflowConfigValues: vi.fn(),
  mockResolveConfigValueWithSource: vi.fn(),
  mockHeader: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
  mockBlankLine: vi.fn(),
  mockInstructionBuild: vi.fn(() => 'phase1'),
  mockReportBuild: vi.fn(() => 'phase2'),
  mockJudgmentBuild: vi.fn(() => 'phase3'),
}));

vi.mock('../infra/config/index.js', () => ({
  loadWorkflowByIdentifier: mockLoadWorkflowByIdentifier,
  resolveWorkflowConfigValue: mockResolveWorkflowConfigValue,
  resolveWorkflowConfigValues: mockResolveWorkflowConfigValues,
  resolveConfigValueWithSource: mockResolveConfigValueWithSource,
}));

vi.mock('../core/workflow/instruction/InstructionBuilder.js', () => ({
  InstructionBuilder: vi.fn().mockImplementation(() => ({
    build: mockInstructionBuild,
  })),
}));

vi.mock('../core/workflow/instruction/ReportInstructionBuilder.js', () => ({
  ReportInstructionBuilder: vi.fn().mockImplementation(() => ({
    build: mockReportBuild,
  })),
}));

vi.mock('../core/workflow/instruction/StatusJudgmentBuilder.js', () => ({
  StatusJudgmentBuilder: vi.fn().mockImplementation(() => ({
    build: mockJudgmentBuild,
  })),
}));

vi.mock('../core/workflow/index.js', () => ({
  needsStatusJudgmentPhase: vi.fn(() => false),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: mockHeader,
  info: mockInfo,
  error: mockError,
  blankLine: mockBlankLine,
}));

import { previewPrompts } from '../features/prompt/preview.js';

describe('previewPrompts', () => {
  let consoleLogSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstructionBuild.mockReturnValue('phase1');
    mockReportBuild.mockReturnValue('phase2');
    mockJudgmentBuild.mockReturnValue('phase3');
    mockResolveWorkflowConfigValue.mockImplementation((_: string, key: string) => {
      if (key === 'workflow') return undefined;
      if (key === 'language') return 'en';
      return undefined;
    });
    mockResolveWorkflowConfigValues.mockReturnValue({
      autoRouting: undefined,
      personaProviders: undefined,
      providerRouting: undefined,
    });
    mockResolveConfigValueWithSource.mockImplementation(() => ({
      value: undefined,
      source: 'default',
    }));
    mockLoadWorkflowByIdentifier.mockReturnValue({
      name: 'default',
      maxSteps: 1,
      steps: [
        {
          name: 'implement',
          personaDisplayName: 'coder',
          outputContracts: [],
        },
      ],
    });
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('workflow未設定時はDEFAULT_WORKFLOW_NAMEでロードする', async () => {
    await previewPrompts('/project');

    expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledWith('default', '/project');
    expect(mockResolveWorkflowConfigValues).toHaveBeenCalledWith(
      '/project',
      ['autoRouting', 'personaProviders', 'providerRouting'],
    );
  });

  it('step番号の見出しを表示する', async () => {
    await previewPrompts('/project');

    expect(console.log).toHaveBeenCalledWith('Step 1: implement (persona: coder)');
  });

  it('ワークフロー用語でステップ数を表示する', async () => {
    await previewPrompts('/project');

    expect(mockInfo).toHaveBeenCalledWith('Steps: 1');
  });

  it('ヘッダーを workflow 用語で表示する', async () => {
    await previewPrompts('/project');

    expect(mockHeader).toHaveBeenCalledWith('Workflow Prompt Preview: default');
  });

  it('未存在ワークフローでは workflow 用語のエラーを表示し他の UI を出さない', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce(undefined);

    await previewPrompts('/project', 'missing-workflow');

    expect(mockError).toHaveBeenCalledWith('Workflow "missing-workflow" not found.');
    expect(mockHeader).not.toHaveBeenCalled();
    expect(mockInfo).not.toHaveBeenCalled();
  });

  it('ワークフロー名とステップ表示の制御文字をサニタイズする', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'bad\x1b[31m-workflow\n',
      maxSteps: 1,
      steps: [
        {
          name: 'impl\tstep',
          personaDisplayName: 'coder\rname',
          outputContracts: [],
        },
      ],
    });

    await previewPrompts('/project');

    expect(mockHeader).toHaveBeenCalledWith('Workflow Prompt Preview: bad-workflow\\n');
    expect(console.log).toHaveBeenCalledWith('Step 1: impl\\tstep (persona: coder\\rname)');
  });

  it('通常stepの実行メタデータを1回だけ表示する', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'default',
      maxSteps: 1,
      steps: [
        {
          name: 'replan',
          personaDisplayName: 'planner',
          outputContracts: [],
          sessionKey: 'exec-replan',
          requiresUserInput: true,
        },
      ],
    });

    await previewPrompts('/project');

    const outputLines = consoleLogSpy.mock.calls.map(([line]) => line);
    expect(outputLines.filter((line) => line === 'Session key: exec-replan')).toHaveLength(1);
    expect(outputLines.filter((line) => line === 'Requires user input: yes')).toHaveLength(1);
  });

  it('finding manager の設定済み provider/model を表示する', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          personaDisplayName: 'Findings Manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
          provider: 'codex',
          model: 'gpt-5.5',
        },
      },
      steps: [
        {
          name: 'review',
          personaDisplayName: 'reviewer',
          outputContracts: [],
        },
      ],
    });

    await previewPrompts('/project');

    expect(mockInfo).toHaveBeenCalledWith('Finding manager: Findings Manager');
    expect(mockInfo).toHaveBeenCalledWith('Finding manager provider: codex');
    expect(mockInfo).toHaveBeenCalledWith('Finding manager model: gpt-5.5');
  });

  it('finding manager の未設定 provider/model は未設定として表示する', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
        },
      },
      steps: [
        {
          name: 'review',
          personaDisplayName: 'reviewer',
          outputContracts: [],
        },
      ],
    });

    await previewPrompts('/project');

    expect(mockInfo).toHaveBeenCalledWith('Finding manager: findings-manager');
    expect(mockInfo).toHaveBeenCalledWith('Finding manager provider: not configured');
    expect(mockInfo).toHaveBeenCalledWith('Finding manager model: not configured');
  });

  it('finding manager の provider/model を runtime と同じ resolver 経由で表示する', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({
      provider: undefined,
      model: undefined,
      personaProviders: {
        'Findings Manager': {
          provider: 'codex',
          model: 'gpt-5.5',
        },
      },
      providerRouting: undefined,
    });
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          personaDisplayName: 'Findings Manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
        },
      },
      steps: [
        {
          name: 'review',
          personaDisplayName: 'reviewer',
          outputContracts: [],
        },
      ],
    });

    await previewPrompts('/project');

    expect(mockInfo).toHaveBeenCalledWith('Finding manager provider: codex');
    expect(mockInfo).toHaveBeenCalledWith('Finding manager model: gpt-5.5');
  });

  it('環境変数由来の provider/model を finding manager の直接指定より優先する', async () => {
    mockResolveConfigValueWithSource.mockImplementation((_: string, key: string) => (
      key === 'provider'
        ? { value: 'mock', source: 'env' }
        : { value: 'env-model', source: 'env' }
    ));
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
          provider: 'codex',
          model: 'step-model',
        },
      },
      steps: [{ name: 'review', personaDisplayName: 'reviewer', outputContracts: [] }],
    });

    await previewPrompts('/project');

    expect(mockInfo).toHaveBeenCalledWith('Finding manager provider: mock');
    expect(mockInfo).toHaveBeenCalledWith('Finding manager model: env-model');
  });

  it('finding manager の provider 直接指定時は persona model を表示しない', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({
      provider: undefined,
      model: undefined,
      personaProviders: {
        'Findings Manager': {
          provider: 'opencode',
          model: 'opencode/persona-model',
        },
      },
      providerRouting: undefined,
    });
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          personaDisplayName: 'Findings Manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
          provider: 'codex',
        },
      },
      steps: [
        {
          name: 'review',
          personaDisplayName: 'reviewer',
          outputContracts: [],
        },
      ],
    });

    await previewPrompts('/project');

    expect(mockInfo).toHaveBeenCalledWith('Finding manager provider: codex');
    expect(mockInfo).toHaveBeenCalledWith('Finding manager model: not configured');
  });

  it('finding manager の静的 auto_routing rule を runtime と同じ候補へ解決する', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({
      provider: undefined,
      model: undefined,
      autoRouting: {
        strategy: 'balanced',
        router: { provider: 'claude-sdk', model: 'claude-haiku-4-5-20251001' },
        candidates: [{
          name: 'manager',
          description: 'Finding manager',
          provider: 'codex',
          model: 'gpt-5.5',
          costTier: 'medium',
        }],
        rules: { steps: { 'findings-manager': 'manager' } },
      },
      personaProviders: undefined,
      providerRouting: undefined,
    });
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
        },
      },
      steps: [{ name: 'review', personaDisplayName: 'reviewer', outputContracts: [] }],
    });

    await previewPrompts('/project');

    expect(mockInfo).toHaveBeenCalledWith('Finding manager provider: codex');
    expect(mockInfo).toHaveBeenCalledWith('Finding manager model: gpt-5.5');
  });

  it('finding manager の auto_routing が動的判定を要する場合は未解決として表示する', async () => {
    mockResolveWorkflowConfigValues.mockReturnValue({
      provider: undefined,
      model: undefined,
      autoRouting: {
        strategy: 'balanced',
        router: { provider: 'claude-sdk', model: 'claude-haiku-4-5-20251001' },
        candidates: [{
          name: 'manager',
          description: 'Finding manager',
          provider: 'codex',
          model: 'gpt-5.5',
          costTier: 'medium',
        }],
        rules: {},
      },
      personaProviders: undefined,
      providerRouting: undefined,
    });
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: {
        ledgerPath: '.takt/findings/peer-review.json',
        rawFindingsPath: '.takt/findings/raw',
        manager: {
          persona: 'findings-manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
        },
      },
      steps: [{ name: 'review', personaDisplayName: 'reviewer', outputContracts: [] }],
    });

    await previewPrompts('/project');

    expect(mockInfo).toHaveBeenCalledWith('Finding manager provider: not configured');
    expect(mockInfo).toHaveBeenCalledWith('Finding manager model: not configured');
  });
});
