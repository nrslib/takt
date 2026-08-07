import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectConfigSchema } from '../core/models/config-schemas.js';
import {
  assertFindingIntakeNormalizerProvider,
  buildFindingIntakeNormalizerSteps,
  findingIntakeNormalizerOverrideChain,
  supportsFindingIntakeNormalizerExecution,
} from '../core/workflow/findings/intake-normalize-policy.js';
import { resolveStepProviderModel } from '../core/workflow/provider-resolution.js';
import { validateFindingContractSyntheticProviderModels } from '../core/workflow/engine/WorkflowValidator.js';
import type { WorkflowConfig } from '../core/models/types.js';
import {
  buildFindingIntakeCorrectionPrompt,
  buildFindingIntakeExtractionPrompt,
} from '../shared/prompts/finding-intake-extraction.js';
import { loadProjectConfig, saveProjectConfig } from '../infra/config/project/projectConfig.js';
import { serializeGlobalConfig } from '../infra/config/global/globalConfigSerializer.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import {
  invalidateAllResolvedConfigCache,
  resolveConfigValue,
} from '../infra/config/resolveConfigValue.js';
import { clearTaktEnv, restoreTaktEnv, type TaktEnvSnapshot } from './helpers/taktEnv.js';

const dirs: string[] = [];
let taktEnv: TaktEnvSnapshot;

beforeEach(() => {
  taktEnv = clearTaktEnv();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  restoreTaktEnv(taktEnv);
});

describe('finding intake normalizer executor', () => {
  const escalation = {
    profile: 'strong',
    provider: 'codex' as const,
    model: 'gpt-5.6-terra',
    providerOptions: { codex: { reasoningEffort: 'high' as const } },
  };

  const seat = { provider: 'opencode' as const, model: 'ollama-cloud/glm-5.2' };

  const seatOverride = {
    provider: 'opencode',
    providerSpecified: true,
    model: 'ollama-cloud/glm-5.2',
    modelSpecified: true,
  };
  const escalationOverride = {
    provider: 'codex',
    providerSpecified: true,
    model: 'gpt-5.6-terra',
    modelSpecified: true,
    providerOptions: { codex: { reasoningEffort: 'high' } },
  };

  it('orders the chain as seat, reviewer escalate target, then the ordinary default resolution', () => {
    expect(findingIntakeNormalizerOverrideChain({ seat, escalation }))
      .toEqual([seatOverride, escalationOverride, {}]);
  });

  it('starts at the reviewer escalate target when there is no seat', () => {
    expect(findingIntakeNormalizerOverrideChain({ seat: undefined, escalation }))
      .toEqual([escalationOverride, {}]);
  });

  it('leaves the normalizer step to the ordinary default resolution without seat or escalate', () => {
    // 空の override = provider/model を直接指定しない = 通常の既定解決に委ねる。
    expect(findingIntakeNormalizerOverrideChain({ seat: undefined, escalation: undefined }))
      .toEqual([{}]);
  });

  it('falls back from the seat straight to the default resolution without escalate', () => {
    expect(findingIntakeNormalizerOverrideChain({ seat, escalation: undefined }))
      .toEqual([seatOverride, {}]);
  });

  it('accepts a resolved provider that implements isolated structured execution', () => {
    expect(() => assertFindingIntakeNormalizerProvider('codex', 'review')).not.toThrow();
    expect(() => assertFindingIntakeNormalizerProvider('opencode', 'review')).not.toThrow();
  });

  it('fails loudly when the resolved provider cannot run isolated structured execution', () => {
    expect(() => assertFindingIntakeNormalizerProvider('cursor', 'review'))
      .toThrow(/does not support isolated structured execution/);
    expect(() => assertFindingIntakeNormalizerProvider(undefined, 'review'))
      .toThrow(/could not be resolved for reviewer "review"/);
  });

  it('reports which providers can carry a retry candidate', () => {
    expect(supportsFindingIntakeNormalizerExecution('codex')).toBe(true);
    expect(supportsFindingIntakeNormalizerExecution('cursor')).toBe(false);
    expect(supportsFindingIntakeNormalizerExecution(undefined)).toBe(false);
  });
});

describe('finding intake normalizer resolution tiers', () => {
  // provider_routing.steps のキーは実運用と同じ `<leaf-workflow>/<step-name>` 形式
  // （runtime.yaml `provider.targets.steps` はこの形のキーをそのまま持ち越す）。
  const REVIEWER_STEP_NAME = 'peer-review/architecture-review';
  const routing = {
    steps: {
      [`${REVIEWER_STEP_NAME}:intake-normalize`]: {
        provider: 'codex' as const,
        model: 'routed-model',
      },
    },
  };

  function resolve(step: Parameters<typeof resolveStepProviderModel>[0]['step']) {
    return resolveStepProviderModel({ step, providerRouting: routing });
  }

  it('treats the default candidate as the workflow tier, not a step-direct one', () => {
    const [defaultCandidate] = buildFindingIntakeNormalizerSteps({
      reviewerStepName: REVIEWER_STEP_NAME,
      seat: undefined,
      escalation: undefined,
      workflowProvider: 'claude',
      workflowModel: 'sonnet',
    });

    // findings-manager と同じ形: 「直指定ではない」を明示する。省略すると
    // provider-resolution が step 直指定（priority 2）として扱い、routing 層を
    // 飛び越える。
    expect(defaultCandidate).toMatchObject({
      provider: 'claude',
      providerSpecified: false,
      model: 'sonnet',
      modelSpecified: false,
    });
    // provider_routing.steps（priority 4）がワークフロー既定（priority 9）に勝つ。
    expect(resolve(defaultCandidate!)).toMatchObject({
      provider: 'codex',
      model: 'routed-model',
    });
  });

  it('keeps the seat candidate above provider routing', () => {
    const [seatCandidate] = buildFindingIntakeNormalizerSteps({
      reviewerStepName: REVIEWER_STEP_NAME,
      seat: { provider: 'opencode', model: 'seat-model' },
      escalation: undefined,
      workflowProvider: 'claude',
      workflowModel: 'sonnet',
    });

    expect(seatCandidate).toMatchObject({ providerSpecified: true, modelSpecified: true });
    expect(resolve(seatCandidate!)).toMatchObject({
      provider: 'opencode',
      model: 'seat-model',
    });
  });
});

describe('finding intake normalizer load-time preflight', () => {
  function findingContractWorkflow(reviewerProvider?: 'cursor' | 'codex'): WorkflowConfig {
    return {
      name: 'fc-preflight',
      initialStep: 'review',
      maxSteps: 4,
      provider: reviewerProvider,
      findingContract: {
        manager: {
          persona: 'findings-manager',
          instruction: 'findings-manager',
          outputContract: 'findings-manager',
        },
        adjudicator: { persona: 'supervisor' },
      },
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review.',
        outputContracts: [{ name: 'review.md', formatRef: 'review-finding-contract' }],
        rules: [{ condition: 'approved', next: 'COMPLETE' }],
      }],
    } as unknown as WorkflowConfig;
  }

  it('rejects a reviewer whose normalizer head candidate cannot run isolated structured execution', () => {
    expect(() => validateFindingContractSyntheticProviderModels(
      findingContractWorkflow('cursor'),
      {},
    )).toThrow(/does not support isolated structured execution/u);
  });

  it('accepts a reviewer whose normalizer head candidate supports it', () => {
    expect(() => validateFindingContractSyntheticProviderModels(
      findingContractWorkflow('codex'),
      {},
    )).not.toThrow();
  });

  it('leaves an unresolved provider to the runtime instead of rejecting at load time', () => {
    // ロード時に見えるのは engine option と workflow の値だけ。未確定を設定エラーに
    // すると、project / global / provider 既定で解決できる構成を拒否してしまう。
    expect(() => validateFindingContractSyntheticProviderModels(
      findingContractWorkflow(undefined),
      {},
    )).not.toThrow();
  });

  it('validates the escalate target that the runtime would use as the head candidate', () => {
    // レビュアーの provider が runtime-v1 defaults 層から解決される構成では、
    // step にも workflow にも escalate は現れない。engine option の
    // providerEscalation を渡さないとロード時の先頭候補が実行時と別物になる。
    const defaultsLayer = {
      provider: 'codex' as const,
      providerSource: 'runtime-v1' as const,
    };

    expect(() => validateFindingContractSyntheticProviderModels(
      findingContractWorkflow(undefined),
      {
        ...defaultsLayer,
        providerEscalation: { profile: 'strong', provider: 'cursor', model: 'cursor-strong' },
      },
    )).toThrow(/does not support isolated structured execution/u);

    expect(() => validateFindingContractSyntheticProviderModels(
      findingContractWorkflow(undefined),
      {
        ...defaultsLayer,
        providerEscalation: {
          profile: 'strong',
          provider: 'opencode',
          model: 'ollama-cloud/glm-5.2',
        },
      },
    )).not.toThrow();
  });

  it('uses the intake-normalizer seat ahead of the workflow default', () => {
    expect(() => validateFindingContractSyntheticProviderModels(
      findingContractWorkflow('codex'),
      { intakeNormalizerProvider: { provider: 'cursor' } },
    )).toThrow(/does not support isolated structured execution/u);
  });
});

describe('finding intake extraction prompt', () => {
  it('uses only the report as source and preserves missing or ambiguous fields', () => {
    const report = '## Finding\nIssue: broken';
    const prompt = buildFindingIntakeExtractionPrompt(report, 'en');
    expect(prompt).toContain(report);
    expect(prompt.match(/## Finding\nIssue: broken/g)).toHaveLength(1);
    expect(prompt).toContain('report below is your only source');
    expect(prompt).toContain('missing or ambiguous scalar fields as `null`');
  });

  it('localizes correction without carrying previous output', () => {
    const prompt = buildFindingIntakeCorrectionPrompt('唯一の報告', 'ja');
    expect(prompt).toContain('下記のレビュー報告だけを情報源');
    expect(prompt).toContain('前回出力の再利用、議論、修復は禁止');
    expect(prompt.match(/唯一の報告/g)).toHaveLength(1);
  });

  it.each([
    ['en' as const, [
      '## Verdict',
      'APPROVE',
      '## Claims',
      'None',
      '## Verification',
      '| Check | Result |',
      '| Cleanup | fixed |',
      '| Host match | resolved |',
    ].join('\n'), [
      'Do not extract approvals,\n   compliments, summaries, verification tables',
      'An APPROVE report whose Claims section says None',
      'return `{"rawFindings":[]}`',
    ]],
    ['ja' as const, [
      '## 判定',
      'APPROVE',
      '## Claims',
      'None',
      '## 検証',
      '| 確認 | 結果 |',
      '| cleanup | すべて修正済み |',
      '| host match | 解消済み |',
    ].join('\n'), [
      '承認、称賛、要約、検証表、\n   レビュースコープ説明',
      'ClaimsがNoneで、残りの要約や検証表が修正済み・解消済みと述べるだけのAPPROVE報告',
      '`{"rawFindings":[]}`を返してください',
    ]],
  ])('%s: APPROVEの要約・検証表をlifecycle claimにしない', (
    language,
    report,
    requiredInstructions,
  ) => {
    const prompt = buildFindingIntakeExtractionPrompt(report, language);
    expect(prompt).toContain(report);
    for (const instruction of requiredInstructions) {
      expect(prompt).toContain(instruction);
    }
  });

  it.each([
    [
      'en' as const,
      'F-0003 relation=resolution_confirmation',
      'only when one contiguous claim passage contains both the\n   literal relation token and an explicit target finding ID',
    ],
    [
      'ja' as const,
      'F-0003 relation=resolution_confirmation',
      '1つの連続したclaim箇所にrelationのliteral tokenと明示的な対象finding IDの両方が\n   ある場合だけ',
    ],
  ])('%s: 同じclaim箇所にrelation tokenとtarget IDを要求する', (
    language,
    claim,
    requiredInstruction,
  ) => {
    const prompt = buildFindingIntakeExtractionPrompt(claim, language);
    expect(prompt).toContain(claim);
    expect(prompt).toContain(requiredInstruction);
    expect(prompt).toContain('`rawExcerpt`');
  });

  it.each([
    [
      'en' as const,
      'The repository architecture creates a dependency cycle.',
      'an issue without a\n   path or line still uses a candidate object with `target: null`; do not turn\n   it into `candidate: null` or discard it',
    ],
    [
      'ja' as const,
      'リポジトリ全体の設計に循環依存があります。',
      '特にpathや行番号がない\n   問題も、`target: null` のcandidate objectとして保持し、`candidate: null`への変換や\n   破棄をしないでください',
    ],
  ])('%s: pathやlineがない明示的な問題もtarget nullで保持する', (
    language,
    claim,
    requiredInstruction,
  ) => {
    const prompt = buildFindingIntakeExtractionPrompt(claim, language);
    expect(prompt).toContain(claim);
    expect(prompt).toContain(requiredInstruction);
  });
});
