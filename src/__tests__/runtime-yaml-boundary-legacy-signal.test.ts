import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { collectLegacyProviderSignals } from '../infra/config/runtime-provider/legacy-signals.js';
import { determineProviderConfigMode } from '../infra/config/runtime-provider/mode.js';
import type { LegacyProviderEnvironmentInput } from '../infra/config/runtime-provider/environment.js';
import type { RuntimeProviderFile } from '../infra/config/runtime-provider/schema.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { resolveAuxiliaryRuntimeEnvironment } from '../infra/config/runtime-provider/provider-environment.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';

/** Workflow promotions are ladder selectors now; they are not legacy provider signals. */

const CLEAN_LEGACY: LegacyProviderEnvironmentInput = {
  provider: undefined,
  providerSource: 'default',
  model: undefined,
  modelSource: 'default',
  personaProviders: undefined,
  providerRouting: undefined,
  autoRouting: undefined,
  providerOptions: undefined,
};

const ACTIVE_RUNTIME_FILE: RuntimeProviderFile = {
  version: 1,
  provider: { defaults: { profile: 'd' }, profiles: { d: { provider: 'mock', model: 'm' } } },
} as unknown as RuntimeProviderFile;

describe('runtime-v1 mixed configuration boundary', () => {
  it('does not report workflow promotion entries as legacy provider signals', () => {
    expect(collectLegacyProviderSignals(CLEAN_LEGACY, 'default')).toEqual([]);
  });

  it('loads a workflow ladder promotion through the runtime-v1 provider boundary', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'takt-runtime-promotion-boundary-'));
    const projectDir = join(rootDir, 'project');
    const globalConfigDir = join(rootDir, 'global');
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const originalConfigDir = process.env.TAKT_CONFIG_DIR;
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(globalConfigDir, { recursive: true });
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    try {
      writeFileSync(join(projectDir, '.takt', 'runtime.yaml'), stringifyYaml({
        version: 1,
        provider: {
          defaults: { ladder: ['base', 'strong'] },
          profiles: {
            base: { provider: 'mock', model: 'base-model' },
            strong: { provider: 'mock', model: 'strong-model' },
          },
        },
      }));
      const workflowPath = join(workflowDir, 'promotion.yaml');
      writeFileSync(workflowPath, stringifyYaml({
        name: 'promotion',
        initial_step: 'implement',
        steps: [{
          name: 'implement',
          instruction: '{task}',
          promotion: [{ at: 2 }],
        }],
      }));

      const workflow = loadWorkflowFromFile(workflowPath, projectDir);
      const resolved = resolveAuxiliaryRuntimeEnvironment(projectDir, workflow);

      expect(workflow.steps[0]?.promotion).toEqual([{ at: 2 }]);
      expect(resolved.providerConfigMode).toBe('runtime-v1');
      expect(resolved.providerEnvironment).toMatchObject({
        provider: 'mock',
        model: 'base-model',
        providerLadders: {
          defaults: [
            { provider: 'mock', model: 'base-model' },
            { provider: 'mock', model: 'strong-model' },
          ],
        },
      });
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.TAKT_CONFIG_DIR;
      } else {
        process.env.TAKT_CONFIG_DIR = originalConfigDir;
      }
      invalidateGlobalConfigCache();
      invalidateAllResolvedConfigCache();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('still rejects a real config.yaml legacy provider signal next to runtime.yaml', () => {
    const signals = collectLegacyProviderSignals({
      ...CLEAN_LEGACY,
      provider: 'codex',
      providerSource: 'global',
    }, 'default');
    expect(() => determineProviderConfigMode({
      runtimeFile: ACTIVE_RUNTIME_FILE,
      legacyProviderSignals: signals,
    })).toThrow(/Mixed provider configuration/i);
  });
});
