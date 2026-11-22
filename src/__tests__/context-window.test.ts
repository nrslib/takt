import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  estimateContextTokens,
  promoteContextWindow,
  selectContextWindow,
} from '../infra/providers/context-window.js';
import { readCodexModelContextWindow } from '../infra/codex/model-context-window.js';
import { buildCodexSessionConfig } from '../infra/codex/session-config.js';
import { buildV2ServerConfig } from '../infra/opencode/v2-config.js';
import { RuntimeProviderFileSchema } from '../infra/config/runtime-provider/schema.js';
import { compileRuntimeProviderEnvironment } from '../infra/config/runtime-provider/environment.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

describe('runtime context_window', () => {
  it('validates the public profile field and inherits it across profile assignments', () => {
    const section = RuntimeProviderFileSchema.parse({
      version: 1,
      provider: {
        defaults: { profile: 'child' },
        profiles: {
          base: { provider: 'codex', model: 'model-a', context_window: 500_000 },
          child: { extends: 'base' },
          other: { provider: 'opencode', model: 'provider/model-b', context_window: 'auto' },
        },
        targets: { steps: { 'demo/review': { profile: 'other' } } },
      },
    }).provider!;
    const environment = compileRuntimeProviderEnvironment(section);
    expect(environment.providerOptions?.codex?.contextWindow).toBe(500_000);
    expect(environment.providerRouting?.steps?.['demo/review']?.providerOptions?.opencode?.contextWindow).toBe('auto');
    for (const invalid of [0, -1, 1.5, 'high', '500000']) {
      expect(RuntimeProviderFileSchema.safeParse({
        version: 1, provider: { defaults: { profile: 'base' }, profiles: {
          base: { provider: 'codex', context_window: invalid },
        } },
      }).success).toBe(false);
    }
  });

  it('uses effective capacity, skips equal stages, and never lowers the default', () => {
    const limits = { default: 272_000, maximum: 872_000, effectivePercent: 95 };
    const high = selectContextWindow('auto', limits, ['A'.repeat(200_000)]);
    expect(high.requiredTokens).toBe(300_000);
    expect(high.override).toBe(500_000);
    expect(high.stages.map((stage) => stage.effectiveSize)).toEqual([258_400, 475_000, 828_400]);
    expect(promoteContextWindow(high).override).toBe(872_000);

    const defaultAtHigh = selectContextWindow('auto', { default: 500_000, maximum: 872_000, effectivePercent: 95 }, ['short']);
    expect(defaultAtHigh.stages.map((stage) => stage.name)).toEqual(['default', 'max']);
    expect(defaultAtHigh.override).toBeUndefined();
    expect(promoteContextWindow(defaultAtHigh).override).toBe(872_000);
  });

  it('keeps an unknown model default and passes a numeric setting unchanged', () => {
    expect(selectContextWindow('auto', undefined, ['A'.repeat(2_000_000)]).override).toBeUndefined();
    const fixed = selectContextWindow(400_000, undefined, ['A'.repeat(2_000_000)]);
    expect(fixed.override).toBe(400_000);
    expect(promoteContextWindow(fixed)).toEqual(fixed);
    expect(estimateContextTokens('日本語')).toBeGreaterThan('日本語'.length / 4);
  });

  it('reads model-specific Codex cache metadata through child CODEX_HOME', async () => {
    const home = mkdtempSync(join(tmpdir(), 'takt-codex-context-'));
    temporaryDirectories.push(home);
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'synthetic-model', context_window: 300_000, max_context_window: 800_000, effective_context_window_percent: 90 }],
    }));
    expect(await readCodexModelContextWindow('synthetic-model', { CODEX_HOME: home }))
      .toEqual({ default: 300_000, maximum: 800_000, effectivePercent: 90 });
    expect(await readCodexModelContextWindow('unknown', { CODEX_HOME: home })).toBeUndefined();
    expect(await readCodexModelContextWindow(undefined, { CODEX_HOME: home })).toBeUndefined();
    writeFileSync(join(home, 'models_cache.json'), '{broken');
    expect(await readCodexModelContextWindow('synthetic-model', { CODEX_HOME: home })).toBeUndefined();
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({
      models: [null, 42, { slug: 'synthetic-model', context_window: 300_000 }],
    }));
    expect(await readCodexModelContextWindow('synthetic-model', { CODEX_HOME: home }))
      .toEqual({ default: 300_000 });
  });

  it('uses Codex base and selected profile windows while avoiding unknown project overrides', async () => {
    const home = mkdtempSync(join(tmpdir(), 'takt-codex-native-window-'));
    temporaryDirectories.push(home);
    const project = join(home, 'project');
    mkdirSync(join(project, '.codex'), { recursive: true });
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'synthetic-model', context_window: 272_000, max_context_window: 872_000 }],
    }));
    const environment = { CODEX_HOME: home };
    const prompt = ['A'.repeat(200_000)];

    const catalogOnly = await readCodexModelContextWindow('synthetic-model', environment, project);
    expect(selectContextWindow('auto', catalogOnly, prompt).override).toBe(500_000);

    writeFileSync(join(home, 'config.toml'), '# model_context_window = 900000\nmodel_context_window = 600_000\n');
    const base = await readCodexModelContextWindow('synthetic-model', environment, project);
    expect(base?.default).toBe(600_000);
    expect(selectContextWindow('auto', base, prompt).override).toBeUndefined();

    writeFileSync(join(home, 'review.config.toml'), 'model_context_window = 700_000\n');
    const selected = await readCodexModelContextWindow('synthetic-model', environment, project, 'review');
    expect(selected?.default).toBe(700_000);
    expect(selectContextWindow('auto', selected, prompt).override).toBeUndefined();

    writeFileSync(join(home, 'config.toml'), 'model_context_window = 800_000\n');
    writeFileSync(join(home, 'review.config.toml'), 'model_context_window = 600_000\n');
    const loweredByProfile = await readCodexModelContextWindow('synthetic-model', environment, project, 'review');
    expect(loweredByProfile?.default).toBe(600_000);
    expect(selectContextWindow('auto', loweredByProfile, ['A'.repeat(850_000)]).override).toBe(872_000);

    writeFileSync(join(project, '.codex', 'config.toml'), 'model_context_window = 800_000\n');
    expect(await readCodexModelContextWindow('synthetic-model', environment, project, 'review')).toBeUndefined();

    rmSync(join(project, '.codex', 'config.toml'));
    writeFileSync(join(home, 'review.config.toml'), 'model_context_window = [broken\n');
    expect(await readCodexModelContextWindow('synthetic-model', environment, project, 'review')).toBeUndefined();
  });

  it('does not mistake CODEX_HOME under HOME for an unknown project config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-codex-home-window-'));
    temporaryDirectories.push(root);
    const home = join(root, '.codex');
    const project = join(root, 'project');
    mkdirSync(home);
    mkdirSync(project);
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'synthetic-model', context_window: 272_000, max_context_window: 872_000 }],
    }));
    writeFileSync(join(home, 'config.toml'), 'model_context_window = 600_000\n');

    const limits = await readCodexModelContextWindow('synthetic-model', { CODEX_HOME: home }, project);
    expect(limits?.default).toBe(600_000);
    expect(selectContextWindow('auto', limits, ['A'.repeat(850_000)]).override).toBe(872_000);
  });

  it('writes the numeric override into native Codex and OpenCode v2 config', () => {
    expect(buildCodexSessionConfig({ cwd: '/tmp', contextWindow: 500_000 }).config.model_context_window).toBe(500_000);
    const config = buildV2ServerConfig('provider/model', 'secret', '/plugin', undefined, false, [], 500_000);
    expect(config.providers?.provider?.models?.model?.limit?.context).toBe(500_000);
    expect(config.providers?.opencode?.settings?.apiKey).toBe('secret');
  });
});
