import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { resolveRuntimeNonWorkflowProvider } from '../infra/config/runtime-provider/internal-agents.js';
import { resolveNonWorkflowProviderModel } from '../infra/config/nonWorkflowProvider.js';
import { initializeSession } from '../features/interactive/sessionInitialization.js';
import {
  getGlobalConfigDir,
  getGlobalConfigPath,
  getProjectConfigDir,
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { RUNTIME_PROVIDER_FILENAME } from '../infra/config/runtime-provider/constants.js';

/**
 * Integration coverage for the non-workflow provider seam reading the runtime.yaml `defaults`
 * profile (issue #1136, CODE-NEW-src-infra-config-nonWorkflowProvider-L6). The non-workflow agents
 * (task summarizer, sync conflict resolver, non-assistant interactive personas) are not the
 * selector/assistant internal agents, so when an active runtime section exists they must:
 * - resolve the `defaults` profile provider/model/options from a single profile (runtimeManaged),
 * - keep the legacy config.yaml provider/model resolution unchanged when no active section exists,
 * - and fail fast on a mixed configuration, symmetric with the selector/assistant seams.
 */

let projectCwd: string;

function writeGlobalConfig(lines: string[]): void {
  writeFileSync(getGlobalConfigPath(), `${lines.join('\n')}\n`);
}

function writeGlobalRuntimeFile(content: unknown): void {
  writeFileSync(join(getGlobalConfigDir(), RUNTIME_PROVIDER_FILENAME), stringifyYaml(content));
}

function invalidate(): void {
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
}

describe('runtime.yaml non-workflow provider resolution', () => {
  beforeEach(() => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-nonworkflow-project-'));
    mkdirSync(getProjectConfigDir(projectCwd), { recursive: true });
    writeGlobalConfig(['language: en']);
    invalidate();
  });

  afterEach(() => {
    rmSync(projectCwd, { recursive: true, force: true });
    invalidate();
  });

  it('resolves the defaults profile provider/model/options in a runtime-v1 environment', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { reasoning_effort: 'high' } },
        },
      },
    });
    invalidate();

    expect(resolveRuntimeNonWorkflowProvider(projectCwd)).toEqual({
      provider: 'codex',
      model: 'gpt-default',
      providerOptions: { codex: { reasoningEffort: 'high' } },
    });
    expect(resolveNonWorkflowProviderModel(projectCwd)).toEqual({
      runtimeManaged: true,
      provider: 'codex',
      model: 'gpt-default',
      providerOptions: { codex: { reasoningEffort: 'high' } },
    });
  });

  it('does not resolve an internal_agents profile for a non-workflow agent (uses defaults)', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default' },
          router: { provider: 'claude', model: 'sonnet' },
        },
        targets: { internal_agents: { selector: { profile: 'router' } } },
      },
    });
    invalidate();

    // The non-workflow seam is not the selector/assistant seam: it resolves `defaults`, not the
    // `internal_agents.selector` profile.
    expect(resolveNonWorkflowProviderModel(projectCwd)).toEqual({
      runtimeManaged: true,
      provider: 'codex',
      model: 'gpt-default',
    });
  });

  it('flows the runtime defaults profile options into a non-assistant session context', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { reasoning_effort: 'high' } },
        },
      },
    });
    invalidate();

    // A non-assistant persona resolves through the non-workflow seam; the runtime profile options
    // must reach the session provider options (the unit the aiCaller consumes).
    const ctx = initializeSession(projectCwd, 'coder');
    expect(ctx.providerType).toBe('codex');
    expect(ctx.model).toBe('gpt-default');
    expect(ctx.providerOptions).toEqual({ codex: { reasoningEffort: 'high' } });
  });

  it('passes legacy config.yaml provider/model through unchanged when no active runtime section exists', () => {
    writeGlobalConfig(['language: en', 'provider: opencode', 'model: opencode/big-pickle']);
    invalidate();

    expect(resolveRuntimeNonWorkflowProvider(projectCwd)).toBeUndefined();
    expect(resolveNonWorkflowProviderModel(projectCwd)).toEqual({
      runtimeManaged: false,
      provider: 'opencode',
      model: 'opencode/big-pickle',
    });
  });

  it('returns undefined runtime resolution for an inactive runtime file (version only)', () => {
    writeGlobalConfig(['language: en', 'provider: claude', 'model: sonnet']);
    writeGlobalRuntimeFile({ version: 1 });
    invalidate();

    expect(resolveRuntimeNonWorkflowProvider(projectCwd)).toBeUndefined();
    expect(resolveNonWorkflowProviderModel(projectCwd)).toEqual({
      runtimeManaged: false,
      provider: 'claude',
      model: 'sonnet',
    });
  });

  it('fails fast when an active runtime section coexists with a legacy config.yaml provider', () => {
    writeGlobalConfig(['language: en', 'provider: opencode', 'model: opencode/big-pickle']);
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-default' } },
      },
    });
    invalidate();

    expect(() => resolveRuntimeNonWorkflowProvider(projectCwd))
      .toThrow(/config\.yaml:provider.*provider\.defaults \+ provider\.profiles/s);
    expect(() => resolveNonWorkflowProviderModel(projectCwd))
      .toThrow(/Mixed provider configuration/);
  });
});
