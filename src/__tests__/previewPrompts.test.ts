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
    providerConfigMode: 'legacy',
  };
}

vi.mock('../core/workflow/instruction/InstructionBuilder.js', () => ({
  InstructionBuilder: mockInstructionBuilder.mockImplementation(() => ({
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

  it('workflow-wide ruleのref・正規化位置・本文を表示する', async () => {
    mockLoadWorkflowByIdentifier.mockReturnValueOnce({
      name: 'rules-preview',
      maxSteps: 1,
      allStepsRules: [{
        ref: 'review-boundary',
        position: 'after_execution_rules',
        content: 'PREVIEW_RULE_BODY',
      }],
      steps: [
        {
          name: 'implement',
          personaDisplayName: 'coder',
          outputContracts: [],
        },
      ],
    });

    await previewPrompts('/project');
    const output = JSON.stringify([
      ...consoleLogSpy.mock.calls,
      ...mockInfo.mock.calls,
    ]);

    expect(output).toContain('review-boundary');
    expect(output).toContain('after_execution_rules');
    expect(output).toContain('PREVIEW_RULE_BODY');
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
          outputContracts: [],
        },
        {
          name: 'synthesized-judge',
          personaDisplayName: 'judge',
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
        companionEnabled: true,
        providerEnvironment: expect.objectContaining({
          provider: undefined,
        }),
        providerConfigMode: 'legacy',
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

});
