import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type {
  CompiledProviderEnvironment,
  ResolvedRuntimeEnvironment,
} from '../infra/config/runtime-provider/provider-environment.js';
import { getProviderValidationErrorSource } from '../core/workflow/provider-validation-error.js';

const {
  mockLoadWorkflowByIdentifier,
  mockResolveWorkflowConfigValue,
  mockResolveWorkflowSelector,
  mockResolveAuxiliaryRuntimeEnvironment,
  mockResolveWorkflowCompanions,
  mockValidateWorkflowCallContracts,
  mockHeader,
  mockInfo,
  mockError,
  mockBlankLine,
  mockInstructionBuilder,
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
  mockResolveAuxiliaryRuntimeEnvironment: vi.fn(),
  mockResolveWorkflowCompanions: vi.fn(),
  mockValidateWorkflowCallContracts: vi.fn(),
  mockHeader: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
  mockBlankLine: vi.fn(),
  mockInstructionBuilder: vi.fn(),
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
// resolveAuxiliaryRuntimeEnvironment; here we drive its resolved output directly.
vi.mock('../infra/config/runtime-provider/provider-environment.js', () => ({
  resolveAuxiliaryRuntimeEnvironment: mockResolveAuxiliaryRuntimeEnvironment,
}));

vi.mock('../infra/config/loaders/workflowResolver.js', () => ({
  validateWorkflowCallContracts: mockValidateWorkflowCallContracts,
}));

vi.mock('../infra/config/workflowCompanionResolution.js', () => ({
  resolveWorkflowCompanions: mockResolveWorkflowCompanions,
}));

function compiledEnvironment(
  overrides: Partial<CompiledProviderEnvironment> = {},
): ResolvedRuntimeEnvironment {
  return {
    providerEnvironment: {
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
      providerLadders: undefined,
      ...overrides,
    },
    companionEnabled: true,
    companionReviewMode: 'completion',
    providerConfigMode: 'legacy',
  };
}

vi.mock('../core/workflow/instruction/InstructionBuilder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/instruction/InstructionBuilder.js')>();
  return {
    ...actual,
    InstructionBuilder: mockInstructionBuilder.mockImplementation((step, context) => {
      const builder = new actual.InstructionBuilder(step, context);
      return {
        build: () => {
          const output = builder.build();
          mockInstructionBuild(output);
          return output;
        },
      };
    }),
  };
});

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
    mockResolveAuxiliaryRuntimeEnvironment.mockReturnValue(compiledEnvironment());
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
            permissionMode: 'readonly',
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
          instruction: 'Implement the requested change.',
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
    expect(mockResolveAuxiliaryRuntimeEnvironment).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ name: 'default' }),
    );
    expect(mockInfo).toHaveBeenCalledWith('Companion review mode: completion');
  });

  it('resolved live modeを補助入口の表示へ渡す', async () => {
    const runtimeEnvironment = compiledEnvironment();
    runtimeEnvironment.companionReviewMode = 'live';
    mockResolveAuxiliaryRuntimeEnvironment.mockReturnValueOnce(runtimeEnvironment);

    await previewPrompts('/project');

    expect(mockInfo).toHaveBeenCalledWith('Companion review mode: live');
  });

  it.each([
    ['completion', 'Findings are delivered in a follow-up prompt'],
    ['live', 'Read new records after finishing each file, before running tests, and before declaring completion.'],
  ] as const)('実際のInstructionBuilderへresolved Companion contextを渡す (%s)', async (reviewMode, expectedText) => {
    const runtimeEnvironment = compiledEnvironment();
    runtimeEnvironment.companionReviewMode = reviewMode;
    mockResolveAuxiliaryRuntimeEnvironment.mockReturnValueOnce(runtimeEnvironment);
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'companion-preview',
      maxSteps: 1,
      steps: [{
        name: 'implement',
        personaDisplayName: 'coder',
        instruction: 'Implement the requested change.',
        edit: true,
        companion: { fixed: ['reviewer'], pool: [] },
        outputContracts: [],
      }],
    });

    await previewPrompts('/project');

    const calls = mockInstructionBuild.mock.calls;
    expect(calls[calls.length - 1]?.[0]).toContain(expectedText);
  });

  // takt prompt は診断ツール。レビュー範囲を解決できなくてもプロンプト本体の
  // プレビューは出す（実行時の fail-fast は変えない）。
  it('スコープ解決が失敗してもプレビューを継続し理由を表示する', async () => {
    mockResolveReviewScopeBaseRange.mockImplementationOnce(() => {
      throw new Error('spawnSync git ENOENT');
    });

    await expect(previewPrompts('/project', undefined, undefined)).resolves.toBeUndefined();
    expect(mockResolveReviewScopeBaseRange).toHaveBeenCalled();
  });

  it('パス収集が失敗してもプレビューを継続し理由を表示する', async () => {
    mockCollectTaskReviewScope.mockImplementationOnce(() => {
      throw new Error('git ls-files --others: repository path is not reversibly UTF-8 encoded');
    });

    await expect(previewPrompts('/project', undefined, undefined)).resolves.toBeUndefined();

    expect(mockResolveReviewScopeBaseRange).toHaveBeenCalledWith('/project');
  });

  it('合成ステップのPhase 1プレビューにはworkflow-wide ruleを渡さない', async () => {
    const workflowRules = [{
      ref: 'review-boundary',
      position: 'after_execution_rules',
      content: 'PREVIEW_RULE_BODY',
    }];
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'rules-preview',
      maxSteps: 2,
      allStepsRules: workflowRules,
      steps: [
        {
          name: 'implement',
          personaDisplayName: 'coder',
          instruction: 'Implement the requested change.',
          outputContracts: [],
        },
        {
          name: 'synthesized-judge',
          personaDisplayName: 'judge',
          instruction: 'Judge the result.',
          outputContracts: [],
          engineSynthesized: true,
        },
      ],
    });

    await previewPrompts('/project');

    expect(mockInstructionBuilder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: 'implement' }),
      expect.objectContaining({ workflowRules }),
    );
    expect(mockInstructionBuilder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: 'synthesized-judge', engineSynthesized: true }),
      expect.objectContaining({ workflowRules: undefined }),
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
        companionEnabled: true,
        providerEnvironment: expect.objectContaining({
          provider: undefined,
        }),
        providerConfigMode: 'legacy',
      },
    );
  });

  it('未存在ワークフローでは workflow 用語のエラーを表示し他の UI を出さない', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce(undefined);

    await previewPrompts('/project', 'missing-workflow');

    expect(mockInfo).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalled();
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
  });

});
