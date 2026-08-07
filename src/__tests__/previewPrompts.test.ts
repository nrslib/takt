import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { CompiledProviderEnvironment } from '../infra/config/runtime-provider/environment.js';
import { getProviderValidationErrorSource } from '../core/workflow/provider-validation-error.js';

const VALID_ADJUDICATOR = {
  persona: 'supervisor',
  provider: 'codex' as const,
  model: 'gpt-5',
};

const {
  mockLoadWorkflowByIdentifier,
  mockResolveWorkflowConfigValue,
  mockResolveWorkflowSelector,
  mockResolveAuxiliaryProviderEnvironment,
  mockValidateWorkflowCallContracts,
  mockHeader,
  mockInfo,
  mockError,
  mockBlankLine,
  mockInstructionBuild,
  mockReportBuild,
  mockJudgmentBuild,
  mockNeedsStatusJudgmentPhase,
  mockResolveReviewScopeBaseRange,
  mockCollectTaskReviewScope,
} = vi.hoisted(() => ({
  mockLoadWorkflowByIdentifier: vi.fn(),
  mockResolveWorkflowConfigValue: vi.fn(),
  mockResolveWorkflowSelector: vi.fn(),
  mockResolveAuxiliaryProviderEnvironment: vi.fn(),
  mockValidateWorkflowCallContracts: vi.fn(),
  mockHeader: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
  mockBlankLine: vi.fn(),
  mockInstructionBuild: vi.fn(() => 'phase1'),
  mockReportBuild: vi.fn(() => 'phase2'),
  mockJudgmentBuild: vi.fn(() => 'phase3'),
  mockNeedsStatusJudgmentPhase: vi.fn(() => false),
  mockResolveReviewScopeBaseRange: vi.fn(),
  mockCollectTaskReviewScope: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  loadWorkflowByIdentifier: mockLoadWorkflowByIdentifier,
  resolveWorkflowConfigValue: mockResolveWorkflowConfigValue,
  resolveWorkflowSelector: mockResolveWorkflowSelector,
}));

// Preview resolves provider/model through the same compiled bundle as execution (issue #1136,
// Unit B). The bundle's runtime-v1/legacy/mixed behavior is covered by the integration tests for
// resolveAuxiliaryProviderEnvironment; here we drive its resolved output directly.
vi.mock('../infra/config/runtime-provider/provider-environment.js', () => ({
  resolveAuxiliaryProviderEnvironment: mockResolveAuxiliaryProviderEnvironment,
}));

vi.mock('../infra/config/loaders/workflowResolver.js', () => ({
  validateWorkflowCallContracts: mockValidateWorkflowCallContracts,
}));

function compiledEnvironment(
  overrides: Partial<CompiledProviderEnvironment> = {},
): CompiledProviderEnvironment {
  return {
    provider: undefined,
    providerSource: 'default',
    model: undefined,
    modelSource: 'default',
    personaProviders: undefined,
    providerRouting: undefined,
    autoRouting: undefined,
    providerOptions: undefined,
    tagConflictPolicy: 'last-wins',
    internalAgents: undefined,
    ...overrides,
  };
}

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
  needsStatusJudgmentPhase: mockNeedsStatusJudgmentPhase,
}));

vi.mock('../core/workflow/review-scope.js', () => ({
  resolveReviewScopeBaseRange: mockResolveReviewScopeBaseRange,
  collectTaskReviewScope: mockCollectTaskReviewScope,
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
    mockResolveAuxiliaryProviderEnvironment.mockReturnValue(compiledEnvironment());
    mockResolveReviewScopeBaseRange.mockReturnValue({ kind: 'base_branch_head' });
    mockCollectTaskReviewScope.mockReturnValue({
      kind: 'collected',
      paths: [],
      source: { kind: 'working_tree', baseRange: { kind: 'base_branch_head' } },
    });
    mockResolveWorkflowSelector.mockImplementation((workflow: {
      steps?: Array<{ parallel?: { kind?: string } }>;
    }) => workflow.steps?.some((step) => step.parallel?.kind === 'dynamic')
      ? {
          applies: true,
          selectorProvider: {
            provider: 'codex',
            model: 'gpt-selector',
            providerSource: 'project',
            modelSource: 'project',
            providerOptions: {},
            nativeTools: ['request_user_input', 'update_plan', 'view_image', 'web_search'],
          },
        }
      : { applies: false });
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
    await previewPrompts('/project', undefined, undefined);

    expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledWith('default', '/project');
    expect(mockResolveAuxiliaryProviderEnvironment).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ name: 'default' }),
    );
  });

  // takt prompt は診断ツール。レビュー範囲を解決できなくてもプロンプト本体の
  // プレビューは出す（実行時の fail-fast は変えない）。
  it('スコープ解決が失敗してもプレビューを継続し理由を表示する', async () => {
    mockResolveReviewScopeBaseRange.mockImplementationOnce(() => {
      throw new Error('spawnSync git ENOENT');
    });

    await expect(previewPrompts('/project', undefined, undefined)).resolves.toBeUndefined();

    expect(mockInfo).toHaveBeenCalledWith('Review scope unavailable: spawnSync git ENOENT');
    expect(console.log).toHaveBeenCalledWith('Step 1: implement (persona: coder)');
    expect(console.log).toHaveBeenCalledWith('phase1');
  });

  it('パス収集が失敗してもプレビューを継続し理由を表示する', async () => {
    mockCollectTaskReviewScope.mockImplementationOnce(() => {
      throw new Error('git ls-files --others: repository path is not reversibly UTF-8 encoded');
    });

    await expect(previewPrompts('/project', undefined, undefined)).resolves.toBeUndefined();

    expect(mockResolveReviewScopeBaseRange).toHaveBeenCalledWith('/project');
    expect(mockInfo).toHaveBeenCalledWith(
      'Review scope unavailable: git ls-files --others: repository path is not reversibly UTF-8 encoded',
    );
    expect(console.log).toHaveBeenCalledWith('Step 1: implement (persona: coder)');
    expect(console.log).toHaveBeenCalledWith('phase1');
  });

  it('step番号の見出しを表示する', async () => {
    await previewPrompts('/project', undefined, undefined);

    expect(console.log).toHaveBeenCalledWith('Step 1: implement (persona: coder)');
  });

  it('dynamic parallel の mode と fixed/pool role を表示する', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'dynamic-preview',
      maxSteps: 1,
      steps: [{
        name: 'reviewers',
        personaDisplayName: 'reviewers',
        outputContracts: [],
        parallel: {
          kind: 'dynamic',
          fixed: [{
            name: 'architecture',
            personaDisplayName: 'architect',
            instruction: 'Review architecture',
            outputContracts: [],
          }],
          pool: [{
            name: 'frontend',
            personaDisplayName: 'frontend reviewer',
            description: 'Review frontend',
            instruction: 'Review frontend',
            outputContracts: [],
          }],
          selection: { mode: 'cumulative' },
        },
      }],
    });

    await previewPrompts('/project');

    expect(console.log).toHaveBeenCalledWith('Dynamic selector mode: cumulative');
    expect(mockInfo).toHaveBeenCalledWith('Dynamic selector provider: codex');
    expect(mockInfo).toHaveBeenCalledWith('Dynamic selector provider options: not configured');
    expect(mockInfo).toHaveBeenCalledWith('Dynamic selector permission: readonly');
    expect(mockInfo).toHaveBeenCalledWith(
      'Dynamic selector native tools: request_user_input, update_plan, view_image, web_search',
    );
    expect(console.log).toHaveBeenCalledWith(
      '\n--- fixed substep 1: architecture (persona: architect) ---\n',
    );
    expect(console.log).toHaveBeenCalledWith(
      '\n--- pool candidate substep 2: frontend (persona: frontend reviewer) ---\n',
    );
  });

  it('selector provider optionsを共通redaction後にだけ端末表示する', async () => {
    mockResolveWorkflowSelector.mockReturnValueOnce({
      applies: true,
      selectorProvider: {
        provider: 'codex',
        model: 'gpt-selector',
        providerSource: 'project',
        modelSource: 'project',
        providerOptions: {
          codex: {
            baseUrl: 'http://selector-user:selector-password@127.0.0.1:8787?token=selector-token',
            reasoningEffort: 'medium',
          },
        },
        nativeTools: [],
      },
    });
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'dynamic-preview',
      maxSteps: 1,
      steps: [{
        name: 'reviewers',
        personaDisplayName: 'reviewers',
        outputContracts: [],
        parallel: {
          kind: 'dynamic',
          fixed: [],
          pool: [{
            name: 'security',
            personaDisplayName: 'security reviewer',
            description: 'Review security',
            instruction: 'Review security',
            outputContracts: [],
          }],
          selection: { mode: 'replace' },
        },
      }],
    });

    await previewPrompts('/project');
    const output = JSON.stringify(mockInfo.mock.calls);

    expect(output).toContain('[configured]');
    expect(output).toContain('reasoningEffort');
    expect(output).toContain('medium');
    expect(output).not.toContain('selector-user');
    expect(output).not.toContain('selector-password');
    expect(output).not.toContain('selector-token');
    expect(output).not.toContain('127.0.0.1:8787');
  });

  it('CLI selector override を dynamic preview の解決境界へ渡す', async () => {
    const overrides = { provider: 'mock' as const, model: 'mock-selector' };
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'dynamic-preview',
      maxSteps: 1,
      steps: [{
        name: 'reviewers',
        personaDisplayName: 'reviewers',
        outputContracts: [],
        parallel: {
          kind: 'dynamic',
          fixed: [],
          pool: [{
            name: 'frontend',
            personaDisplayName: 'frontend reviewer',
            description: 'Review frontend',
            instruction: 'Review frontend',
            outputContracts: [],
          }],
          selection: { mode: 'replace' },
        },
      }],
    });

    await previewPrompts('/project', undefined, overrides);

    expect(mockResolveWorkflowSelector).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'dynamic-preview' }),
      {
        projectCwd: '/project',
        lookupCwd: '/project',
        overrides,
      },
    );
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

  it('共通判定が不要とした step では Phase 3 prompt を表示しない', async () => {
    await previewPrompts('/project');

    expect(mockNeedsStatusJudgmentPhase).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'implement' }),
      false,
    );
    expect(mockJudgmentBuild).not.toHaveBeenCalled();
  });

  it('共通判定が必要とした step では Phase 3 prompt を表示する', async () => {
    mockNeedsStatusJudgmentPhase.mockReturnValueOnce(true);

    await previewPrompts('/project');

    expect(mockJudgmentBuild).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith('\n--- Phase 3 (Status Judgment) ---\n');
    expect(console.log).toHaveBeenCalledWith('phase3');
  });

  it('finding manager の設定済み provider/model を表示する', async () => {
    mockResolveAuxiliaryProviderEnvironment.mockReturnValueOnce(compiledEnvironment({
      provider: 'codex',
      providerSource: 'project',
      model: 'gpt-5.5',
      modelSource: 'project',
    }));
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: {
        manager: {
          persona: 'findings-manager',
          personaDisplayName: 'Findings Manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
          provider: 'codex',
          model: 'gpt-5.5',
        },
        adjudicator: {
          persona: 'supervisor',
          personaDisplayName: 'Finding Adjudicator',
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
    expect(mockInfo).toHaveBeenCalledWith('Finding adjudicator: Finding Adjudicator');
    expect(mockInfo).toHaveBeenCalledWith('Finding adjudicator provider: codex');
    expect(mockInfo).toHaveBeenCalledWith('Finding adjudicator model: gpt-5.5');
    expect(mockValidateWorkflowCallContracts).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'finding-contract-preview' }),
      '/project',
      '/project',
      {
        providerValidationOptions: expect.objectContaining({
          provider: 'codex',
          providerSource: 'project',
          model: 'gpt-5.5',
          modelSource: 'project',
        }),
      },
    );
  });

  it('finding manager の未設定 provider/model は未設定として表示する', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
        },
        adjudicator: VALID_ADJUDICATOR,
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
    mockResolveAuxiliaryProviderEnvironment.mockReturnValue(compiledEnvironment({
      personaProviders: {
        'Findings Manager': {
          provider: 'codex',
          model: 'gpt-5.5',
        },
      },
    }));
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: {
        manager: {
          persona: 'findings-manager',
          personaDisplayName: 'Findings Manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
        },
        adjudicator: VALID_ADJUDICATOR,
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
    mockResolveAuxiliaryProviderEnvironment.mockReturnValue(compiledEnvironment({
      provider: 'mock',
      providerSource: 'env',
      model: 'env-model',
      modelSource: 'env',
    }));
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
          provider: 'codex',
          model: 'step-model',
        },
        adjudicator: VALID_ADJUDICATOR,
      },
      steps: [{ name: 'review', personaDisplayName: 'reviewer', outputContracts: [] }],
    });

    await previewPrompts('/project');

    expect(mockInfo).toHaveBeenCalledWith('Finding manager provider: mock');
    expect(mockInfo).toHaveBeenCalledWith('Finding manager model: env-model');
  });

  it('findings-manager seat 指定時は persona model を表示しない', async () => {
    mockResolveAuxiliaryProviderEnvironment.mockReturnValue(compiledEnvironment({
      personaProviders: {
        'Findings Manager': {
          provider: 'opencode',
          model: 'opencode/persona-model',
        },
      },
      internalAgents: { findingsManager: { provider: 'codex' } },
    }));
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: {
        manager: {
          persona: 'findings-manager',
          personaDisplayName: 'Findings Manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
        },
        adjudicator: VALID_ADJUDICATOR,
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
    mockResolveAuxiliaryProviderEnvironment.mockReturnValue(compiledEnvironment({
      autoRouting: {
        strategy: 'balanced',
        router: { provider: 'claude-sdk', model: 'claude-haiku-4-5-20251001' },
        candidates: [{
          name: 'manager',
          description: 'Finding manager',
          provider: 'codex',
          model: 'gpt-5.5',
          routingTier: 'medium',
        }],
        defaultPool: 'general',
        candidatePools: { general: { candidates: ['manager'], fallback: 'manager' } },
        rules: { steps: { 'findings-manager': 'manager' } },
      },
    }));
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
        },
        adjudicator: VALID_ADJUDICATOR,
      },
      steps: [{ name: 'review', personaDisplayName: 'reviewer', outputContracts: [] }],
    });

    await previewPrompts('/project');

    expect(mockInfo).toHaveBeenCalledWith('Finding manager provider: codex');
    expect(mockInfo).toHaveBeenCalledWith('Finding manager model: gpt-5.5');
  });

  it('finding manager は auto_routing の rules 不一致でも strategy デフォルトへ確定して表示する', async () => {
    mockResolveAuxiliaryProviderEnvironment.mockReturnValue(compiledEnvironment({
      autoRouting: {
        strategy: 'balanced',
        router: { provider: 'claude-sdk', model: 'claude-haiku-4-5-20251001' },
        candidates: [{
          name: 'manager',
          description: 'Finding manager',
          provider: 'codex',
          model: 'gpt-5.5',
          routingTier: 'medium',
        }],
        defaultPool: 'general',
        candidatePools: { general: { candidates: ['manager'], fallback: 'manager' } },
        rules: {},
      },
    }));
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
        },
        adjudicator: VALID_ADJUDICATOR,
      },
      steps: [{ name: 'review', personaDisplayName: 'reviewer', outputContracts: [] }],
    });

    await previewPrompts('/project');

    // findings-manager は AI ルーターを通らず、実行時は strategy デフォルト
    // 候補へ決定的に解決される。preview も同じ値を表示する。
    expect(mockInfo).toHaveBeenCalledWith('Finding manager provider: codex');
    expect(mockInfo).toHaveBeenCalledWith('Finding manager model: gpt-5.5');
  });

  it.each([
    {
      role: 'manager',
      environment: compiledEnvironment({
        personaProviders: {
          'Findings Manager': { provider: 'opencode' },
        },
      }),
      contract: {
        manager: {
          persona: 'findings-manager',
          personaDisplayName: 'Findings Manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
        },
        adjudicator: VALID_ADJUDICATOR,
      },
      source: 'persona_providers',
    },
    {
      role: 'adjudicator',
      environment: compiledEnvironment({
        providerRouting: {
          personas: { supervisor: { provider: 'opencode' } },
        },
      }),
      contract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'manager instruction',
          outputContract: 'manager output contract',
          provider: 'codex' as const,
          model: 'gpt-5',
        },
        adjudicator: { persona: 'supervisor' },
      },
      source: 'provider_routing.personas',
    },
  ])('workflow_call のない root でも不正な finding $role provider を拒否する', async ({
    environment,
    contract,
    source,
  }) => {
    mockResolveAuxiliaryProviderEnvironment.mockReturnValueOnce(environment);
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'finding-contract-preview',
      maxSteps: 1,
      findingContract: contract,
      steps: [{ name: 'review', personaDisplayName: 'reviewer', outputContracts: [] }],
    });

    let validationError: unknown;
    try {
      await previewPrompts('/project');
    } catch (error) {
      validationError = error;
    }

    expect(validationError).toBeInstanceOf(Error);
    expect((validationError as Error).message).toContain("provider 'opencode' requires model");
    expect(getProviderValidationErrorSource(validationError)).toMatchObject({
      field: 'provider',
      source,
    });
    expect(mockValidateWorkflowCallContracts).not.toHaveBeenCalled();
  });
});
