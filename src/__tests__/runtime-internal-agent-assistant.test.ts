/**
 * The `assistant` seat in runtime.yaml decides which provider every interactive
 * conversation talks to — both front-ends read it through the same ladder. A
 * setting that is written in a form the schema does not accept must say so
 * loudly: falling back to `defaults` without a word is how a user ends up
 * talking to a model they thought they had replaced.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAssistantProviderModel } from '../features/interactive/assistantConfig.js';
import { resolveRuntimeInternalAgentProvider } from '../infra/config/runtime-provider/internal-agents.js';
import { initializeSession } from '../features/interactive/sessionInitialization.js';

const PROFILES = [
  'version: 1',
  '',
  'provider:',
  '  profiles:',
  '    claude-opus:',
  '      provider: claude-sdk',
  '      model: opus',
  '    kimi-k3:',
  '      provider: opencode',
  '      model: moonshotai/kimi-k3',
  '  defaults:',
  '    profile: kimi-k3',
  '  targets:',
].join('\n');

const roots: string[] = [];

/** Points the loaders at a runtime.yaml built for one case. */
function withRuntime(targets: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-seat-'));
  roots.push(root);
  const configDir = join(root, '.takt');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'runtime.yaml'), `${[PROFILES, ...targets].join('\n')}\n`, 'utf-8');
  process.env.TAKT_CONFIG_DIR = configDir;
  return root;
}

afterEach(() => {
  delete process.env.TAKT_CONFIG_DIR;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('the assistant seat', () => {
  it('should be honoured when it names a profile', () => {
    const cwd = withRuntime([
      '    internal_agents:',
      '      assistant:',
      '        profile: claude-opus',
    ]);

    expect(resolveRuntimeInternalAgentProvider(cwd, 'assistant'))
      .toMatchObject({ provider: 'claude-sdk', model: 'opus' });
    expect(resolveAssistantProviderModel(cwd))
      .toMatchObject({ runtimeManaged: true, provider: 'claude-sdk', model: 'opus' });
  });

  it('should reach the session both front-ends build', () => {
    const cwd = withRuntime([
      '    internal_agents:',
      '      assistant:',
      '        profile: claude-opus',
    ]);

    // `interactive` is the persona the readline flow and the TUI both resolve.
    const ctx = initializeSession(cwd, 'interactive');

    expect(ctx.providerType).toBe('claude-sdk');
    expect(ctx.model).toBe('opus');
  });

  it('should fall back to the defaults profile only when no seat is written', () => {
    const cwd = withRuntime(['    tags: {}']);

    expect(resolveAssistantProviderModel(cwd))
      .toMatchObject({ provider: 'opencode', model: 'moonshotai/kimi-k3' });
  });

  describe('a seat the schema cannot accept', () => {
    it('should refuse a provider/model written in place of a profile', () => {
      const cwd = withRuntime([
        '    internal_agents:',
        '      assistant:',
        '        provider: claude-sdk',
        '        model: opus',
      ]);

      expect(() => resolveAssistantProviderModel(cwd)).toThrow(/Unrecognized keys.*provider/s);
    });

    it('should refuse a bare profile name', () => {
      const cwd = withRuntime([
        '    internal_agents:',
        '      assistant: claude-opus',
      ]);

      expect(() => resolveAssistantProviderModel(cwd)).toThrow(/expected object/);
    });

    it('should refuse a profile that does not exist', () => {
      const cwd = withRuntime([
        '    internal_agents:',
        '      assistant:',
        '        profile: does-not-exist',
      ]);

      expect(() => resolveAssistantProviderModel(cwd))
        .toThrow(/Unknown profile "does-not-exist" referenced by targets\.internal_agents\.assistant/);
    });

    it('should refuse a seat name it does not serve', () => {
      const cwd = withRuntime([
        '    internal_agents:',
        '      assistants:',
        '        profile: claude-opus',
      ]);

      expect(() => resolveAssistantProviderModel(cwd)).toThrow(/supports only .*`assistant`/s);
    });

    it('should refuse internal_agents written outside targets', () => {
      const root = mkdtempSync(join(tmpdir(), 'takt-seat-'));
      roots.push(root);
      const configDir = join(root, '.takt');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'runtime.yaml'),
        `${PROFILES.replace('  targets:', [
          '  internal_agents:',
          '    assistant:',
          '      profile: claude-opus',
          '  targets:',
        ].join('\n'))}\n    tags: {}\n`,
        'utf-8',
      );
      process.env.TAKT_CONFIG_DIR = configDir;

      expect(() => resolveAssistantProviderModel(root)).toThrow(/Unrecognized key.*internal_agents/s);
    });
  });
});
