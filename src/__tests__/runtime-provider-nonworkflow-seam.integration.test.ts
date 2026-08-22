import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { resolveRuntimeNonWorkflowProvider } from '../infra/config/runtime-provider/internal-agents.js';
import { resolveNonWorkflowProviderModel } from '../infra/config/nonWorkflowProvider.js';
import { initializeSession } from '../features/interactive/sessionInitialization.js';
import { askExecAssistant, createExecSessionContext } from '../features/exec/assistantSession.js';
import { DEFAULT_EXEC_CONFIG } from '../features/exec/defaults.js';
import type { ResolvedExecConfig } from '../features/exec/types.js';
import {
  getGlobalConfigDir,
  getGlobalConfigPath,
  getProjectConfigDir,
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { RUNTIME_PROVIDER_FILENAME } from '../infra/config/runtime-provider/constants.js';
import type { RuntimeProviderFile } from '../infra/config/runtime-provider/schema.js';

const { mockCallCodex, mockCallCodexCustom } = vi.hoisted(() => ({
  mockCallCodex: vi.fn(),
  mockCallCodexCustom: vi.fn(),
}));

vi.mock('../infra/codex/index.js', () => ({
  callCodex: mockCallCodex,
  callCodexCustom: mockCallCodexCustom,
}));

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

function writeGlobalRuntimeFile(content: RuntimeProviderFile): void {
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

  it('keeps disabled companion-only targets in legacy mode for non-workflow resolution', () => {
    writeGlobalConfig(['language: en', 'provider: claude', 'model: legacy-model']);
    writeGlobalRuntimeFile({
      version: 1,
      companion: { enabled: false },
      provider: {
        profiles: {
          security: { provider: 'mock', model: 'mock-security' },
        },
        targets: { companions: { security: { profile: 'security' } } },
      },
    });
    invalidate();

    expect(resolveRuntimeNonWorkflowProvider(projectCwd)).toBeUndefined();
    expect(resolveNonWorkflowProviderModel(projectCwd)).toEqual({
      runtimeManaged: false,
      provider: 'claude',
      model: 'legacy-model',
    });
  });

  it('flows the runtime defaults profile options into a non-assistant session context', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: {
            provider: 'codex',
            model: 'gpt-default',
            options: { reasoning_effort: 'high' },
            permission_mode: 'readonly',
          },
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
    expect(ctx.permissionMode).toBe('readonly');
  });

  it.each([false, true])(
    'flows runtime defaults fast_mode=%s into the exec assistant terminal',
    async (profileFastMode) => {
      writeGlobalRuntimeFile({
        version: 1,
        provider: {
          defaults: { profile: 'default' },
          profiles: {
            default: {
              provider: 'codex',
              model: 'gpt-default',
              options: { fast_mode: profileFastMode },
            },
          },
        },
      });
      const previousFastMode = process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE;
      delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE;
      invalidate();

      try {
        const config: ResolvedExecConfig = {
          ...DEFAULT_EXEC_CONFIG,
          session: { provider: 'codex', model: 'gpt-default' },
          workers: DEFAULT_EXEC_CONFIG.workers.map((worker) => ({ ...worker, provider: 'codex' })),
          reviews: DEFAULT_EXEC_CONFIG.reviews.map((review) => ({ ...review, provider: 'codex' })),
        };
        const ctx = createExecSessionContext(projectCwd, config);

        expect(ctx.providerOptions).toMatchObject({
          codex: {
            fastMode: profileFastMode,
            skills: { repo: true, user: true },
          },
        });

        mockCallCodexCustom.mockReset();
        mockCallCodexCustom.mockResolvedValue({
          content: 'done',
          sessionId: 'exec-session',
          status: 'completed',
        });
        const result = await askExecAssistant(
          projectCwd,
          ctx,
          'prompt',
          'system',
          { outputMode: 'silent', persistSession: false },
        );

        expect(result.content).toBe('done');
        expect(mockCallCodexCustom.mock.calls[0]?.[3]).toMatchObject({
          fastMode: profileFastMode,
        });
      } finally {
        if (previousFastMode === undefined) {
          delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE;
        } else {
          process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE = previousFastMode;
        }
        invalidate();
      }
    },
  );

  it.each([
    { profileFastMode: false, envFastMode: true },
    { profileFastMode: true, envFastMode: false },
  ])('lets config/env options win over the exec runtime profile, including network access', async ({
    profileFastMode,
    envFastMode,
  }) => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: {
            provider: 'codex',
            model: 'gpt-default',
            options: { fast_mode: profileFastMode, network_access: true },
          },
        },
      },
    });
    const previousFastMode = process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE;
    const previousNetworkAccess = process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS;
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE = String(envFastMode);
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS = 'false';
    invalidate();
    try {
      const config: ResolvedExecConfig = {
        ...DEFAULT_EXEC_CONFIG,
        session: { provider: 'codex', model: 'gpt-default' },
        workers: DEFAULT_EXEC_CONFIG.workers.map((worker) => ({ ...worker, provider: 'codex' })),
        reviews: DEFAULT_EXEC_CONFIG.reviews.map((review) => ({ ...review, provider: 'codex' })),
      };
      const ctx = createExecSessionContext(projectCwd, config);

      expect(ctx.providerOptions).toMatchObject({
        codex: {
          fastMode: envFastMode,
          networkAccess: false,
        },
      });

      mockCallCodexCustom.mockReset();
      mockCallCodexCustom.mockResolvedValue({
        content: 'done',
        sessionId: 'exec-session',
        status: 'completed',
      });
      const result = await askExecAssistant(
        projectCwd,
        ctx,
        'prompt',
        'system',
        { outputMode: 'silent', persistSession: false },
      );

      expect(result.content).toBe('done');
      expect(mockCallCodexCustom.mock.calls[0]?.[3]).toMatchObject({
        fastMode: envFastMode,
        networkAccess: false,
      });
    } finally {
      if (previousFastMode === undefined) {
        delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE;
      } else {
        process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE = previousFastMode;
      }
      if (previousNetworkAccess === undefined) {
        delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS;
      } else {
        process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS = previousNetworkAccess;
      }
      invalidate();
    }
  });

  it('treats an env-source provider as an override that drops the runtime model/options', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { reasoning_effort: 'high' } },
        },
      },
    });
    const previous = process.env.TAKT_PROVIDER;
    process.env.TAKT_PROVIDER = 'claude';
    invalidate();
    try {
      expect(resolveNonWorkflowProviderModel(projectCwd)).toEqual({
        runtimeManaged: true,
        provider: 'claude',
      });

      const ctx = initializeSession(projectCwd, 'coder');
      expect(ctx.providerType).toBe('claude');
      expect(ctx.model).toBeUndefined();
      expect(ctx.providerOptions).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.TAKT_PROVIDER;
      } else {
        process.env.TAKT_PROVIDER = previous;
      }
      invalidate();
    }
  });

  it('treats an env-source model as an override that keeps the runtime provider/options', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { reasoning_effort: 'high' } },
        },
      },
    });
    const previous = process.env.TAKT_MODEL;
    process.env.TAKT_MODEL = 'gpt-env';
    invalidate();
    try {
      expect(resolveNonWorkflowProviderModel(projectCwd)).toEqual({
        runtimeManaged: true,
        provider: 'codex',
        model: 'gpt-env',
        providerOptions: { codex: { reasoningEffort: 'high' } },
      });

      const ctx = initializeSession(projectCwd, 'coder');
      expect(ctx.providerType).toBe('codex');
      expect(ctx.model).toBe('gpt-env');
      expect(ctx.providerOptions).toEqual({ codex: { reasoningEffort: 'high' } });
    } finally {
      if (previous === undefined) {
        delete process.env.TAKT_MODEL;
      } else {
        process.env.TAKT_MODEL = previous;
      }
      invalidate();
    }
  });

  it('fails fast when the active section omits defaults and has no auto routing', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        profiles: { router: { provider: 'claude', model: 'sonnet' } },
        targets: { internal_agents: { selector: { profile: 'router' } } },
      },
    } as unknown as RuntimeProviderFile);
    invalidate();

    expect(() => resolveRuntimeNonWorkflowProvider(projectCwd)).toThrow(/defaults/);
    expect(() => resolveNonWorkflowProviderModel(projectCwd)).toThrow(/defaults/);
  });

  it('fails fast when an env provider override requires a model the override does not carry', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-default' } },
      },
    });
    const previous = process.env.TAKT_PROVIDER;
    process.env.TAKT_PROVIDER = 'opencode';
    invalidate();
    try {
      // The provider override drops the runtime model; opencode requires a `provider/model`
      // model, so the seam must fail fast instead of deferring the error to the provider SDK.
      expect(() => resolveNonWorkflowProviderModel(projectCwd))
        .toThrow(/provider 'opencode' requires model/);
    } finally {
      if (previous === undefined) {
        delete process.env.TAKT_PROVIDER;
      } else {
        process.env.TAKT_PROVIDER = previous;
      }
      invalidate();
    }
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

  // Unit: mcp-only runtime (active `mcp` section, no `provider` section) must not throw at the
  // non-workflow seam. The `mcp` assignment flows through the workflow bootstrap; provider/model
  // resolution stays on the legacy config.yaml path (order.md:36, symmetric with
  // resolveCompiledProviderEnvironment in provider-environment.ts). With no legacy provider
  // signals the seam returns `undefined` so the caller keeps legacy resolution.
  it('returns undefined for an mcp-only runtime so the non-workflow seam keeps legacy config.yaml resolution', () => {
    writeGlobalConfig(['language: en']);
    writeGlobalRuntimeFile({
      version: 1,
      mcp: {
        servers: {
          'common-tools': { type: 'stdio', command: 'common-srv' },
        },
        defaults: { servers: ['common-tools'] },
      },
    });
    invalidate();

    expect(resolveRuntimeNonWorkflowProvider(projectCwd)).toBeUndefined();
    expect(resolveNonWorkflowProviderModel(projectCwd)).toEqual({
      runtimeManaged: false,
      provider: 'claude',
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
