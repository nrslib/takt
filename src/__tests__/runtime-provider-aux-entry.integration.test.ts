import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import {
  resolveAuxiliaryProviderEnvironment,
  resolveAuxiliaryRuntimeEnvironment,
} from '../infra/config/runtime-provider/provider-environment.js';
import { getWorkflowDescription } from '../infra/config/loaders/workflowPreview.js';
import { resolveConfiguredExecProviderModel } from '../features/exec/runtimeConfig.js';
import {
  getGlobalConfigDir,
  getGlobalConfigPath,
  getProjectConfigDir,
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { RUNTIME_PROVIDER_FILENAME } from '../infra/config/runtime-provider/constants.js';
import type { WorkflowConfig } from '../core/models/index.js';
import type { RuntimeProviderFile } from '../infra/config/runtime-provider/schema.js';

/**
 * Integration coverage for the shared auxiliary provider-environment entry (issue #1136, Unit B).
 * preview and doctor resolve provider/model through this single function, so it must:
 * - surface runtime.yaml `profiles.default` in a runtime-v1 environment (not legacy defaults),
 * - pass legacy config.yaml provider/model through unchanged when no active runtime section exists,
 * - fail fast when an active runtime section coexists with legacy provider settings.
 */

const WORKFLOW: Pick<WorkflowConfig, 'name'> = {
  name: 'aux-entry-workflow',
};

let projectCwd: string;

function writeGlobalConfig(lines: string[]): void {
  writeFileSync(getGlobalConfigPath(), `${lines.join('\n')}\n`);
}

function writeGlobalRuntimeFile(content: RuntimeProviderFile): void {
  writeFileSync(join(getGlobalConfigDir(), RUNTIME_PROVIDER_FILENAME), stringifyYaml(content));
}

const MIXED_CONFIG_PROVIDER_ERROR = /config\.yaml:provider.*provider\.defaults \+ provider\.profiles/s;

function activeRuntimeSection(): RuntimeProviderFile {
  return {
    version: 1,
    provider: {
      defaults: { profile: 'default' },
      profiles: { default: { provider: 'codex', model: 'gpt-runtime' } },
    },
  };
}

describe('resolveAuxiliaryProviderEnvironment', () => {
  beforeEach(() => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-aux-entry-project-'));
    mkdirSync(getProjectConfigDir(projectCwd), { recursive: true });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(projectCwd, { recursive: true, force: true });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('resolves runtime.yaml profiles.default in a runtime-v1 environment', () => {
    writeGlobalConfig(['language: en']);
    writeGlobalRuntimeFile(activeRuntimeSection());
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const env = resolveAuxiliaryProviderEnvironment(projectCwd, WORKFLOW);

    expect(env.provider).toBe('codex');
    expect(env.model).toBe('gpt-runtime');
    expect(env.providerSource).toBe('runtime-v1');
    expect(env.modelSource).toBe('runtime-v1');
    expect(env.tagConflictPolicy).toBe('fail-fast');
  });

  it('propagates the effective companion review mode through the auxiliary runtime environment', () => {
    writeGlobalConfig(['language: en']);
    writeGlobalRuntimeFile({
      ...activeRuntimeSection(),
      companion: { enabled: true, review_mode: 'live', fix_policy: 'loop' },
    } as unknown as RuntimeProviderFile);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const env = resolveAuxiliaryRuntimeEnvironment(projectCwd, WORKFLOW);

    expect((env as unknown as { companionReviewMode?: string }).companionReviewMode).toBe('live');
    expect((env as unknown as { companionFixPolicy?: string }).companionFixPolicy).toBe('loop');
  });

  it('Given companion.fix_policy is omitted, When resolving auxiliary runtime environment, Then it defaults to single', () => {
    writeGlobalConfig(['language: en']);
    writeGlobalRuntimeFile({
      ...activeRuntimeSection(),
      companion: { enabled: true },
    } as unknown as RuntimeProviderFile);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const env = resolveAuxiliaryRuntimeEnvironment(projectCwd, WORKFLOW);

    expect((env as unknown as { companionFixPolicy?: string }).companionFixPolicy).toBe('single');
  });

  it('passes legacy config.yaml provider/model through unchanged when no active runtime section exists', () => {
    writeGlobalConfig(['language: en', 'provider: opencode', 'model: opencode/big-pickle']);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const env = resolveAuxiliaryProviderEnvironment(projectCwd, WORKFLOW);

    expect(env.provider).toBe('opencode');
    expect(env.model).toBe('opencode/big-pickle');
    expect(env.providerSource).toBe('global');
    expect(env.tagConflictPolicy).toBe('last-wins');
  });

  it('fails fast when an active runtime section coexists with a legacy config.yaml provider', () => {
    writeGlobalConfig(['language: en', 'provider: opencode', 'model: opencode/big-pickle']);
    writeGlobalRuntimeFile(activeRuntimeSection());
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    expect(() => resolveAuxiliaryProviderEnvironment(projectCwd, WORKFLOW))
      .toThrow(MIXED_CONFIG_PROVIDER_ERROR);
  });
});

function writeWorkflow(fileName: string, lines: string[]): void {
  const workflowDir = join(getProjectConfigDir(projectCwd), 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, fileName), `${lines.join('\n')}\n`);
}

describe('getWorkflowDescription consumes the compiled provider environment', () => {
  beforeEach(() => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-aux-preview-project-'));
    mkdirSync(getProjectConfigDir(projectCwd), { recursive: true });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(projectCwd, { recursive: true, force: true });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('previews runtime.yaml profiles.default provider/model and resolves allowed-tools against it', () => {
    writeGlobalConfig(['language: en']);
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: {
            provider: 'opencode',
            model: 'opencode/big-pickle',
            options: { allowed_tools: ['read', 'grep'] },
            permission_mode: 'readonly',
          },
        },
      },
    });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    writeWorkflow('preview-runtime.yaml', [
      'name: preview-runtime',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    instruction: Implement the change.',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ]);

    const description = getWorkflowDescription('preview-runtime', projectCwd, 1);
    const step = description.stepPreviews[0] as {
      name: string;
      provider?: string;
      model?: string;
      permissionMode?: string;
      allowedTools: string[];
    };

    // provider/model come from the runtime.yaml bundle, and allowed-tools resolve from that
    // profile's provider options (not a silent legacy default).
    expect(step).toMatchObject({
      name: 'implement',
      provider: 'opencode',
      model: 'opencode/big-pickle',
      permissionMode: 'readonly',
    });
    expect(step.allowedTools).toEqual(['read', 'grep']);
  });

  it('previews only the winning step profile options and permission', () => {
    writeGlobalConfig(['language: en']);
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: {
            provider: 'opencode',
            model: 'opencode/big-pickle',
            options: { allowed_tools: ['read', 'grep'] },
            permission_mode: 'readonly',
          },
          plain: { provider: 'claude', model: 'sonnet' },
        },
        targets: { steps: { implement: { profile: 'plain' } } },
      },
    });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    writeWorkflow('preview-step-profile.yaml', [
      'name: preview-step-profile',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    instruction: Implement the change.',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ]);

    const step = getWorkflowDescription('preview-step-profile', projectCwd, 1).stepPreviews[0];

    expect(step).toMatchObject({ provider: 'claude', model: 'sonnet', allowedTools: [] });
    expect(step).not.toHaveProperty('permissionMode');
  });

  it('fails fast when a step maps to conflicting same-priority tag routing in runtime-v1', () => {
    writeGlobalConfig(['language: en']);
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-runtime' },
          a: { provider: 'claude', model: 'sonnet' },
          b: { provider: 'opencode', model: 'qwen' },
        },
        targets: {
          tags: {
            t1: { profile: 'a' },
            t2: { profile: 'b' },
          },
        },
      },
    });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    writeWorkflow('preview-tag-conflict.yaml', [
      'name: preview-tag-conflict',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    instruction: Implement the change.',
      '    tags: [t1, t2]',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ]);

    expect(() => getWorkflowDescription('preview-tag-conflict', projectCwd, 1))
      .toThrow(/[Cc]onflicting provider routing/);
  });

  it('resolves same-priority tag routing in legacy mode by last-wins', () => {
    writeGlobalConfig([
      'language: en',
      'provider: claude',
      'model: sonnet',
      'provider_routing:',
      '  tags:',
      '    t1:',
      '      provider: claude',
      '      model: sonnet',
      '    t2:',
      '      provider: codex',
      '      model: gpt-5',
    ]);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    writeWorkflow('preview-legacy-tags.yaml', [
      'name: preview-legacy-tags',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    instruction: Implement the change.',
      '    tags: [t1, t2]',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ]);

    const description = getWorkflowDescription('preview-legacy-tags', projectCwd, 1);

    // Legacy last-wins: the last matching tag (t2) supplies the provider/model. A first-wins or
    // defaults regression would surface claude/sonnet here.
    expect(description.stepPreviews).toContainEqual(
      expect.objectContaining({
        name: 'implement',
        provider: 'codex',
        model: 'gpt-5',
      }),
    );
  });

  it('fails fast in preview when an active runtime section coexists with a legacy provider', () => {
    writeGlobalConfig(['language: en', 'provider: opencode', 'model: opencode/big-pickle']);
    writeGlobalRuntimeFile(activeRuntimeSection());
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    writeWorkflow('preview-mixed.yaml', [
      'name: preview-mixed',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    instruction: Implement the change.',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ]);

    expect(() => getWorkflowDescription('preview-mixed', projectCwd, 1))
      .toThrow(MIXED_CONFIG_PROVIDER_ERROR);
  });

  it('passes legacy config.yaml provider/model through preview when no runtime section exists', () => {
    writeGlobalConfig(['language: en', 'provider: opencode', 'model: opencode/big-pickle']);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    writeWorkflow('preview-legacy.yaml', [
      'name: preview-legacy',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    instruction: Implement the change.',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ]);

    const description = getWorkflowDescription('preview-legacy', projectCwd, 1);

    expect(description.stepPreviews[0]).toMatchObject({
      name: 'implement',
      provider: 'opencode',
      model: 'opencode/big-pickle',
    });
  });
});

describe('resolveConfiguredExecProviderModel consumes the compiled provider environment', () => {
  beforeEach(() => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-aux-exec-project-'));
    mkdirSync(getProjectConfigDir(projectCwd), { recursive: true });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(projectCwd, { recursive: true, force: true });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('returns the runtime.yaml profiles.default provider/model in a runtime-v1 environment', () => {
    writeGlobalConfig(['language: en']);
    writeGlobalRuntimeFile(activeRuntimeSection());
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    expect(resolveConfiguredExecProviderModel(projectCwd)).toEqual({
      provider: 'codex',
      model: 'gpt-runtime',
    });
  });

  it('fails fast when an active runtime section coexists with a legacy config.yaml provider', () => {
    writeGlobalConfig(['language: en', 'provider: opencode', 'model: opencode/big-pickle']);
    writeGlobalRuntimeFile(activeRuntimeSection());
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    expect(() => resolveConfiguredExecProviderModel(projectCwd))
      .toThrow(MIXED_CONFIG_PROVIDER_ERROR);
  });

  it('passes the legacy config.yaml provider/model through when no runtime section exists', () => {
    writeGlobalConfig(['language: en', 'provider: opencode', 'model: opencode/big-pickle']);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    expect(resolveConfiguredExecProviderModel(projectCwd)).toEqual({
      provider: 'opencode',
      model: 'opencode/big-pickle',
    });
  });
});
