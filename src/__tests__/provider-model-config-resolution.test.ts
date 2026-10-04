import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { resolveStepProviderModel } from '../core/workflow/provider-resolution.js';
import { resolveAuxiliaryRuntimeEnvironment } from '../infra/config/runtime-provider/provider-environment.js';

const configFiles = vi.hoisted(() => new Map<string, string>());

vi.mock('node:fs', async (importOriginal) => {
  const originalFs = await importOriginal<typeof import('node:fs')>();
  return {
    ...originalFs,
    existsSync: (filePath: Parameters<typeof originalFs.existsSync>[0]) => (
      configFiles.has(resolve(String(filePath))) || originalFs.existsSync(filePath)
    ),
    readFileSync: (
      filePath: Parameters<typeof originalFs.readFileSync>[0],
      options?: Parameters<typeof originalFs.readFileSync>[1],
    ) => {
      const content = configFiles.get(resolve(String(filePath)));
      if (content === undefined) {
        return originalFs.readFileSync(filePath, options);
      }
      const encoding = typeof options === 'string' ? options : options?.encoding;
      return (encoding === undefined ? Buffer.from(content) : content) as ReturnType<typeof originalFs.readFileSync>;
    },
  };
});

function withProviderConfigFiles(
  input: { projectConfig?: string; globalConfig?: string },
  action: (projectDir: string) => void,
): void {
  const projectDir = resolve('/virtual/provider-model-config/project');
  const globalDir = resolve('/virtual/provider-model-config/global');
  if (input.projectConfig !== undefined) {
    configFiles.set(resolve(projectDir, '.takt', 'config.yaml'), input.projectConfig);
  }
  if (input.globalConfig !== undefined) {
    configFiles.set(resolve(globalDir, 'config.yaml'), input.globalConfig);
  }

  const previousConfigDir = process.env.TAKT_CONFIG_DIR;
  process.env.TAKT_CONFIG_DIR = globalDir;
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
  try {
    action(projectDir);
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    configFiles.clear();
  }
}

describe('legacy config model provider ownership', () => {
  it('Given a global provider/model pair, When the CLI overrides the provider, Then it drops the paired model', () => {
    withProviderConfigFiles({ globalConfig: 'provider: claude\nmodel: opus\n' }, (projectDir) => {
      const environment = resolveAuxiliaryRuntimeEnvironment(projectDir, {
        name: 'provider-model-config',
        steps: [],
      }).providerEnvironment;
      expect(environment).toMatchObject({
        provider: 'claude',
        providerSource: 'global',
        model: 'opus',
        modelSource: 'global',
        modelProvider: 'claude',
      });

      const result = resolveStepProviderModel({
        ...environment,
        step: { name: 'plan', provider: undefined, model: undefined, personaDisplayName: 'coder' },
        provider: 'copilot',
        providerSource: 'cli',
      });

      expect(result).toMatchObject({
        provider: 'copilot',
        providerSource: 'cli',
        model: undefined,
        modelSource: 'default',
      });
    });
  });

  it('Given a global model-only setting and a schema-default provider, When the CLI overrides the provider, Then it passes the model through', () => {
    withProviderConfigFiles({ globalConfig: 'model: gpt-5\n' }, (projectDir) => {
      const environment = resolveAuxiliaryRuntimeEnvironment(projectDir, {
        name: 'provider-model-config',
        steps: [],
      }).providerEnvironment;
      expect(environment.model).toBe('gpt-5');
      expect(environment.modelSource).toBe('global');
      expect(environment.modelProvider).toBeUndefined();

      const result = resolveStepProviderModel({
        ...environment,
        step: { name: 'plan', provider: undefined, model: undefined, personaDisplayName: 'coder' },
        provider: 'copilot',
        providerSource: 'cli',
      });

      expect(result).toMatchObject({
        provider: 'copilot',
        providerSource: 'cli',
        model: 'gpt-5',
        modelSource: 'global',
      });
    });
  });

  it('Given a project provider/model pair, When the CLI overrides the provider, Then it drops the project model', () => {
    withProviderConfigFiles({ projectConfig: 'provider: claude\nmodel: opus\n' }, (projectDir) => {
      const environment = resolveAuxiliaryRuntimeEnvironment(projectDir, {
        name: 'provider-model-config',
        steps: [],
      }).providerEnvironment;
      expect(environment).toMatchObject({
        provider: 'claude',
        providerSource: 'project',
        model: 'opus',
        modelSource: 'project',
        modelProvider: 'claude',
      });

      const result = resolveStepProviderModel({
        ...environment,
        step: { name: 'plan', provider: undefined, model: undefined, personaDisplayName: 'coder' },
        provider: 'copilot',
        providerSource: 'cli',
      });

      expect(result).toMatchObject({
        provider: 'copilot',
        providerSource: 'cli',
        model: undefined,
        modelSource: 'default',
      });
    });
  });

  it('Given a global provider/model pair and a provider environment override, When resolving, Then it drops the paired model', () => {
    vi.stubEnv('TAKT_PROVIDER', 'copilot');
    try {
      withProviderConfigFiles({ globalConfig: 'provider: claude\nmodel: opus\n' }, (projectDir) => {
        const environment = resolveAuxiliaryRuntimeEnvironment(projectDir, {
          name: 'provider-model-config',
          steps: [],
        }).providerEnvironment;
        expect(environment).toMatchObject({
          provider: 'copilot',
          providerSource: 'env',
          model: 'opus',
          modelSource: 'global',
          modelProvider: 'claude',
        });

        const result = resolveStepProviderModel({
          ...environment,
          step: { name: 'plan', provider: undefined, model: undefined, personaDisplayName: 'coder' },
        });

        expect(result).toMatchObject({
          provider: 'copilot',
          providerSource: 'env',
          model: undefined,
          modelSource: 'default',
        });
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses the provider explicitly paired in a provider block', () => {
    withProviderConfigFiles({
      globalConfig: 'provider:\n  type: claude\n  model: opus\n',
    }, (projectDir) => {
      const environment = resolveAuxiliaryRuntimeEnvironment(projectDir, {
        name: 'provider-model-config',
        steps: [],
      }).providerEnvironment;
      expect(environment).toMatchObject({
        provider: 'claude',
        providerSource: 'global',
        model: 'opus',
        modelSource: 'global',
        modelProvider: 'claude',
      });

      const result = resolveStepProviderModel({
        ...environment,
        step: { name: 'plan', provider: undefined, model: undefined, personaDisplayName: 'coder' },
        provider: 'copilot',
        providerSource: 'cli',
      });
      expect(result).toMatchObject({
        provider: 'copilot',
        model: undefined,
        modelSource: 'default',
      });
    });
  });
});
