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
  reviewerOutput: 'structured',
  manager: {
    persona: 'findings-manager',
    instruction: 'findings-manager',
    outputContract: 'findings-manager',
  },
};
const plainTextFindingContract: FindingContractConfig = {
  ...findingContract,
  reviewerOutput: 'plain_text_normalized',
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

describe('intake_normalize config', () => {
  it('rejects absent provider/model, empty targets, and unknown keys', () => {
    expect(() => ProjectConfigSchema.parse({ intake_normalize: {} })).toThrow();
    expect(() => ProjectConfigSchema.parse({
      intake_normalize: { provider: 'codex' },
    })).not.toThrow();
    expect(() => normalizeFindingIntakeNormalize({
      provider: 'codex',
    })).toThrow(/model is required/);
    expect(() => ProjectConfigSchema.parse({
      intake_normalize: { provider: 'codex', model: 'gpt', targets: [] },
    })).toThrow();
    expect(() => ProjectConfigSchema.parse({
      intake_normalize: { provider: 'codex', model: 'gpt', unexpected: true },
    })).toThrow();
  });

  it('accepts provider block form and round-trips provider options and targets', () => {
    const normalized = normalizeFindingIntakeNormalize({
      provider: {
        type: 'codex',
        model: 'gpt-5.6-terra',
        network_access: false,
      },
      targets: ['takt-default-localllm'],
      provider_options: {
        codex: { reasoning_effort: 'high' },
      },
    });
    expect(normalized).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-terra',
      targets: ['takt-default-localllm'],
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
      targets: ['takt-default-localllm'],
      provider_options: {
        codex: {
          network_access: false,
          reasoning_effort: 'high',
        },
      },
    });
  });

  it('loads and saves the project block and serializes the global block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'takt-intake-normalize-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.takt'), { recursive: true });
    writeFileSync(join(dir, '.takt', 'config.yaml'), [
      'intake_normalize:',
      '  provider: codex',
      '  model: gpt-5.6-terra',
      '  targets: [target-a]',
      '',
    ].join('\n'));

    const loaded = loadProjectConfig(dir);
    expect(loaded.intakeNormalize).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-terra',
      targets: ['target-a'],
    });
    saveProjectConfig(dir, loaded);
    expect(readFileSync(join(dir, '.takt', 'config.yaml'), 'utf8')).toContain('intake_normalize:');
    expect(serializeGlobalConfig({
      language: 'en',
      provider: 'claude',
      intakeNormalize: loaded.intakeNormalize,
    })).toMatchObject({
      intake_normalize: {
        provider: 'codex',
        model: 'gpt-5.6-terra',
        targets: ['target-a'],
      },
    });
  });

  it('resolves the project block atomically over the global block', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-intake-project-'));
    const globalDir = mkdtempSync(join(tmpdir(), 'takt-intake-global-'));
    dirs.push(projectDir, globalDir);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    process.env.TAKT_CONFIG_DIR = globalDir;
    writeFileSync(join(globalDir, 'config.yaml'), [
      'language: en',
      'intake_normalize:',
      '  provider: codex',
      '  model: gpt-5.6-terra',
      '  targets: [global-target]',
      '  provider_options:',
      '    codex:',
      '      reasoning_effort: high',
      '',
    ].join('\n'));
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'intake_normalize:',
      '  provider: mock',
      '  model: project-model',
      '  targets: [project-target]',
      '',
    ].join('\n'));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    expect(resolveConfigValue(projectDir, 'intakeNormalize')).toEqual({
      provider: 'mock',
      model: 'project-model',
      targets: ['project-target'],
    });

    writeFileSync(join(projectDir, '.takt', 'config.yaml'), '');
    invalidateAllResolvedConfigCache();
    expect(resolveConfigValue(projectDir, 'intakeNormalize')).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-terra',
      targets: ['global-target'],
      providerOptions: {
        codex: { reasoningEffort: 'high' },
      },
    });
  });
});

describe('intake normalizer policy', () => {
  const config = { provider: 'codex', model: 'gpt-5.6-terra' } as const;

  it('is disabled without the block or an effective Finding Contract', () => {
    expect(resolveFindingIntakeNormalizeConfig(undefined, 'child', findingContract)).toBeUndefined();
    expect(resolveFindingIntakeNormalizeConfig(config, 'child', undefined)).toBeUndefined();
    expect(resolveFindingIntakeNormalizeConfig(config, 'child', findingContract)).toBeUndefined();
  });

  it('requires a config and matches exact workflow names, including workflow_call child names', () => {
    expect(() => resolveFindingIntakeNormalizeConfig(
      undefined,
      'child',
      plainTextFindingContract,
    )).toThrow(/intake_normalize is not configured/);
    expect(resolveFindingIntakeNormalizeConfig(
      config,
      'child',
      plainTextFindingContract,
    )).toBe(config);
    const targeted = { ...config, targets: ['child'] };
    expect(resolveFindingIntakeNormalizeConfig(
      targeted,
      'child',
      plainTextFindingContract,
    )).toBe(targeted);
    expect(() => resolveFindingIntakeNormalizeConfig(
      targeted,
      'Child',
      plainTextFindingContract,
    )).toThrow(/not included in intake_normalize.targets/);
    expect(() => resolveFindingIntakeNormalizeConfig(
      targeted,
      'parent',
      plainTextFindingContract,
    )).toThrow(/not included in intake_normalize.targets/);
    expect(() => resolveFindingIntakeNormalizeConfig(
      { provider: 'claude', model: 'sonnet' },
      'child',
      plainTextFindingContract,
    )).toThrow(/does not support isolated structured execution/);
  });
});

describe('finding contract reviewer output strategy', () => {
  it('is selected only by workflow Finding Contract, regardless of normalizer config', () => {
    const normalizerConfig = {
      provider: 'codex',
      model: 'gpt-5.6-terra',
      targets: ['workflow'],
    } as const;
    const canonicalContract: FindingContractConfig = {
      ledgerPath: '.takt/findings/ledger.json',
      rawFindingsPath: '.takt/findings/raw',
      reviewerOutput: 'canonical_blocks',
      manager: {
        persona: 'findings-manager',
        instruction: 'findings-manager',
        outputContract: 'findings-manager',
      },
    };
    expect(resolveFindingIntakeNormalizeConfig(
      normalizerConfig,
      'workflow',
      canonicalContract,
    )).toBeUndefined();
    expect(resolveFindingContractReviewerOutputStrategy(canonicalContract))
      .toEqual({
        kind: 'canonical_blocks',
        reportGeneration: 'plain_text',
        intake: 'canonical_parser',
      });
    expect(resolveFindingContractReviewerOutputStrategy({
      ledgerPath: '.takt/findings/ledger.json',
      rawFindingsPath: '.takt/findings/raw',
      reviewerOutput: 'structured',
      manager: {
        persona: 'findings-manager',
        instruction: 'findings-manager',
        outputContract: 'findings-manager',
      },
    })).toEqual({
      kind: 'structured',
      reportGeneration: 'structured',
      intake: 'reviewer_structured',
    });
    expect(resolveFindingContractReviewerOutputStrategy({
      ...canonicalContract,
      reviewerOutput: 'plain_text_normalized',
    })).toEqual({
      kind: 'plain_text_normalized',
      reportGeneration: 'plain_text',
      intake: 'isolated_normalizer',
    });
  });
});

describe('finding intake extraction prompt', () => {
  it('uses only the report as source and preserves missing or ambiguous fields', () => {
    const report = '## Finding\nIssue: broken';
    const prompt = buildFindingIntakeExtractionPrompt(report, 'en');
    expect(prompt).toContain('## Finding\nIssue: broken');
    expect(prompt.match(/## Finding\nIssue: broken/g)).toHaveLength(1);
    expect(prompt).toContain('report below is your only source');
    expect(prompt).toContain('missing or ambiguous scalar fields as `null`');
    expect(prompt).toMatch(/broad\s+architecture or repository-design issue/u);
    expect(prompt).not.toContain('canonical block');
  });

  it('localizes the prompt and gives correction no previous output', () => {
    const prompt = buildFindingIntakeCorrectionPrompt('唯一の報告', 'ja');
    expect(prompt).toContain('下記のレビュー報告だけを情報源');
    expect(prompt).toContain('前回出力の再利用、議論、修復は禁止');
    expect(prompt.match(/唯一の報告/g)).toHaveLength(1);
  });
});
