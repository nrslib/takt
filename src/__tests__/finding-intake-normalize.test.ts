import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectConfigSchema } from '../core/models/config-schemas.js';
import type { FindingContractConfig } from '../core/models/finding-types.js';
import { resolveFindingIntakeNormalizeConfig } from '../core/workflow/findings/intake-normalize-policy.js';
import {
  resolveFindingContractReviewerOutputStrategy,
} from '../core/workflow/findings/reviewer-output-strategy.js';
import {
  buildFindingIntakeCorrectionPrompt,
  buildFindingIntakeExtractionPrompt,
} from '../shared/prompts/finding-intake-extraction.js';
import {
  denormalizeFindingIntakeNormalize,
  normalizeFindingIntakeNormalize,
} from '../infra/config/configNormalizers.js';
import { loadProjectConfig, saveProjectConfig } from '../infra/config/project/projectConfig.js';
import { serializeGlobalConfig } from '../infra/config/global/globalConfigSerializer.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import {
  invalidateAllResolvedConfigCache,
  resolveConfigValue,
} from '../infra/config/resolveConfigValue.js';
import { clearTaktEnv, restoreTaktEnv, type TaktEnvSnapshot } from './helpers/taktEnv.js';

const dirs: string[] = [];
const findingContract: FindingContractConfig = {
  ledgerPath: '.takt/findings/peer-review.json',
  rawFindingsPath: '.takt/findings/raw',
  manager: {
    persona: 'findings-manager',
    instruction: 'findings-manager',
    outputContract: 'findings-manager',
  },
};
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

describe('finding_contract.intake_normalize config', () => {
  it('rejects the removed top-level key and malformed or duplicate targets', () => {
    expect(() => ProjectConfigSchema.parse({
      intake_normalize: { provider: 'codex', model: 'gpt' },
    })).toThrow();
    expect(() => ProjectConfigSchema.parse({
      finding_contract: { intake_normalize: { provider: 'codex', model: 'gpt', targets: [] } },
    })).toThrow();
    expect(() => ProjectConfigSchema.parse({
      finding_contract: {
        intake_normalize: {
          provider: 'codex',
          model: 'gpt',
          targets: [
            { provider: 'opencode', model: 'gemma4' },
            { provider: 'opencode', model: 'gemma4' },
          ],
        },
      },
    })).toThrow(/must not contain duplicates/);
  });

  it('normalizes and serializes strict provider/model targets', () => {
    const normalized = normalizeFindingIntakeNormalize({
      provider: {
        type: 'codex',
        model: 'gpt-5.6-terra',
        network_access: false,
      },
      targets: [{ provider: 'opencode', model: 'ollama-cloud/gemma4:31b' }],
      provider_options: {
        codex: { reasoning_effort: 'high' },
      },
    });
    expect(normalized).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-terra',
      targets: [{ provider: 'opencode', model: 'ollama-cloud/gemma4:31b' }],
      providerOptions: {
        codex: {
          networkAccess: false,
          reasoningEffort: 'high',
        },
      },
    });
    expect(denormalizeFindingIntakeNormalize(normalized)).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-terra',
      targets: [{ provider: 'opencode', model: 'ollama-cloud/gemma4:31b' }],
      provider_options: {
        codex: {
          network_access: false,
          reasoning_effort: 'high',
        },
      },
    });
  });

  it('loads, saves, and resolves the namespaced project/global setting', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-intake-project-'));
    const globalDir = mkdtempSync(join(tmpdir(), 'takt-intake-global-'));
    dirs.push(projectDir, globalDir);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    process.env.TAKT_CONFIG_DIR = globalDir;
    writeFileSync(join(globalDir, 'config.yaml'), [
      'language: en',
      'finding_contract:',
      '  intake_normalize:',
      '    provider: codex',
      '    model: gpt-5.6-terra',
      '',
    ].join('\n'));
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'finding_contract:',
      '  intake_normalize:',
      '    provider: mock',
      '    model: project-model',
      '    targets:',
      '      - provider: opencode',
      '        model: ollama-cloud/gemma4:31b',
      '',
    ].join('\n'));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const loaded = loadProjectConfig(projectDir);
    expect(loaded.findingContract?.intakeNormalize).toEqual({
      provider: 'mock',
      model: 'project-model',
      targets: [{ provider: 'opencode', model: 'ollama-cloud/gemma4:31b' }],
    });
    expect(resolveConfigValue(projectDir, 'findingContract')).toEqual(loaded.findingContract);
    saveProjectConfig(projectDir, loaded);
    expect(readFileSync(join(projectDir, '.takt', 'config.yaml'), 'utf8'))
      .toContain('finding_contract:');
    expect(serializeGlobalConfig({
      language: 'en',
      provider: 'claude',
      findingContract: loaded.findingContract,
    })).toMatchObject({
      finding_contract: {
        intake_normalize: {
          provider: 'mock',
          model: 'project-model',
        },
      },
    });
  });
});

describe('reviewer output strategy', () => {
  const normalizer = {
    provider: 'codex',
    model: 'gpt-5.6-terra',
    targets: [{ provider: 'opencode', model: 'ollama-cloud/gemma4:31b' }],
  } as const;

  it('matches the resolved reviewer provider and model exactly', () => {
    expect(resolveFindingContractReviewerOutputStrategy(
      findingContract,
      normalizer,
      { provider: 'opencode', model: 'ollama-cloud/gemma4:31b' },
    )?.kind).toBe('plain_text_normalized');
    expect(resolveFindingContractReviewerOutputStrategy(
      findingContract,
      normalizer,
      { provider: 'opencode', model: 'ollama-cloud/gemma4:27b' },
    )?.kind).toBe('structured');
    expect(resolveFindingContractReviewerOutputStrategy(
      findingContract,
      normalizer,
      { provider: 'codex', model: 'gpt-5.6-sol' },
    )?.kind).toBe('structured');
  });

  it('targets every Finding reviewer only when targets is omitted', () => {
    expect(resolveFindingContractReviewerOutputStrategy(
      findingContract,
      { provider: 'codex', model: 'gpt-5.6-terra' },
      { provider: 'codex', model: 'gpt-5.6-sol' },
    )?.kind).toBe('plain_text_normalized');
    expect(resolveFindingContractReviewerOutputStrategy(
      findingContract,
      undefined,
      { provider: 'codex', model: 'gpt-5.6-sol' },
    )?.kind).toBe('structured');
  });

  it('validates the isolated normalizer provider independently of targets', () => {
    expect(resolveFindingIntakeNormalizeConfig(
      { provider: 'codex', model: 'gpt-5.6-terra' },
      findingContract,
    )).toBeDefined();
    expect(() => resolveFindingIntakeNormalizeConfig(
      { provider: 'claude', model: 'sonnet' },
      findingContract,
    )).toThrow(/finding_contract\.intake_normalize/);
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
