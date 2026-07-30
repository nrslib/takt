import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectConfigSchema } from '../core/models/config-schemas.js';
import type { FindingContractConfig } from '../core/models/finding-types.js';
import { resolveFindingIntakeNormalizeConfig } from '../core/workflow/findings/intake-normalize-policy.js';
import {
  buildFindingIntakeExtractionPrompt,
  FINDING_INTAKE_EXTRACTION_PROMPT_TEMPLATE,
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
const findingContract = {} as FindingContractConfig;
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
  });

  it('matches exact canonical workflow names, including workflow_call child names', () => {
    expect(resolveFindingIntakeNormalizeConfig(config, 'child', findingContract)).toBe(config);
    const targeted = { ...config, targets: ['child'] };
    expect(resolveFindingIntakeNormalizeConfig(targeted, 'child', findingContract)).toBe(targeted);
    expect(resolveFindingIntakeNormalizeConfig(targeted, 'Child', findingContract)).toBeUndefined();
    expect(resolveFindingIntakeNormalizeConfig(targeted, 'parent', findingContract)).toBeUndefined();
  });
});

describe('finding intake extraction prompt SSOT', () => {
  it('preserves the evaluated template hash and substitutes only the report', () => {
    expect(createHash('sha256').update(FINDING_INTAKE_EXTRACTION_PROMPT_TEMPLATE).digest('hex'))
      .toBe('688f2777230baf23b298c87d0823391ef9c6b233697bd910aec0aa449a15fe29');
    expect(FINDING_INTAKE_EXTRACTION_PROMPT_TEMPLATE.match(/\{\{REPORT\}\}/g)).toHaveLength(1);
    const prompt = buildFindingIntakeExtractionPrompt('## Finding\nIssue: broken');
    expect(prompt).toContain('## Finding\nIssue: broken');
    expect(prompt).not.toContain('{{REPORT}}');
  });
});
