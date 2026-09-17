import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import {
  resolveCompiledProviderEnvironment,
  resolveRuntimeEnvironment,
} from '../infra/config/runtime-provider/provider-environment.js';
import type { LegacyProviderEnvironmentInput } from '../infra/config/runtime-provider/environment.js';
import type { LegacyProviderSignal } from '../infra/config/runtime-provider/mode.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
  resolveProviderOptionsWithTrace,
} from '../infra/config/index.js';
import { getGlobalConfigDir, getGlobalConfigPath } from '../infra/config/paths.js';
import { RUNTIME_PROVIDER_FILENAME } from '../infra/config/runtime-provider/constants.js';

// Consumption-side seam (issue #1208): drive a compiled runtime.yaml environment through a real
// WorkflowEngine so a target-less `{at:N}` promotion advances the governing ladder. The engine
// dependencies below are mocked exactly as workflow-promotion-engine.test.ts does; the existing
// generation-side tests above never touch these modules, so the mocks leave them unaffected.
vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return {
    ...actual,
    RuleEvaluator: MockRuleEvaluator,
  };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import type { WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import type { StructuredCaller } from '../agents/structured-caller.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import { runWorkflowExecution } from '../features/tasks/execute/workflowExecutionApi.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  makeRule,
  makeStep,
  mockRuleEvaluationSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';

/**
 * Integration coverage for the composed provider-environment seam (issue #1136, T1):
 * loader → mode detection → environment compilation, driven through the real filesystem.
 * Asserts the active→runtime-v1 provider/model + persona/tag/step routing mapping, the legacy
 * passthrough, and the mixed-configuration fail-fast (location + migrateTo).
 */

const legacyInput: LegacyProviderEnvironmentInput = {
  provider: 'codex',
  providerSource: 'global',
  model: 'gpt-x',
  modelSource: 'global',
  personaProviders: undefined,
  providerRouting: undefined,
  autoRouting: undefined,
  providerOptions: undefined,
};

let projectCwd: string;

function writeGlobalRuntimeFile(content: unknown): void {
  writeFileSync(
    join(getGlobalConfigDir(), RUNTIME_PROVIDER_FILENAME),
    stringifyYaml(content),
  );
}

function companionReviewMode(value: unknown): string | undefined {
  return (value as { companionReviewMode?: string } | undefined)?.companionReviewMode;
}

describe('resolveCompiledProviderEnvironment seam', () => {
  beforeEach(() => {
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-seam-project-'));
    mkdirSync(join(projectCwd, '.takt'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectCwd, { recursive: true, force: true });
  });

  it('maps an active runtime-v1 section to provider/model + routing with fail-fast tag policy', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default' },
          reviewer: { provider: 'opencode', model: 'qwen' },
          impl: { provider: 'cursor', model: 'cur-m' },
          tagp: { provider: 'claude', model: 'sonnet' },
        },
        targets: {
          personas: { coder: { profile: 'reviewer' } },
          tags: { 'high-stakes': { profile: 'tagp' } },
          steps: { 'wf/impl': { profile: 'impl' } },
        },
      },
    });

    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    expect(env.provider).toBe('codex');
    expect(env.model).toBe('gpt-default');
    expect(env.providerSource).toBe('runtime-v1');
    expect(env.modelSource).toBe('runtime-v1');
    expect(env.tagConflictPolicy).toBe('fail-fast');
    expect(env.personaProviders).toEqual({ coder: { provider: 'opencode', model: 'qwen' } });
    expect(env.providerRouting).toEqual({
      tags: { 'high-stakes': { provider: 'claude', model: 'sonnet' } },
      steps: { 'wf/impl': { provider: 'cursor', model: 'cur-m' } },
    });
  });

  it('carries runtime profile fast_mode through the compiled defaults and routing entries', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { fast_mode: false } },
          persona: { provider: 'codex', model: 'gpt-persona', options: { fast_mode: true } },
          tag: { provider: 'codex', model: 'gpt-tag', options: { fast_mode: false } },
          step: { provider: 'codex', model: 'gpt-step', options: { fast_mode: true } },
        },
        targets: {
          personas: { coder: { profile: 'persona' } },
          tags: { 'high-stakes': { profile: 'tag' } },
          steps: { 'wf/impl': { profile: 'step' } },
        },
      },
    });

    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    expect(env.providerOptions).toEqual({ codex: { fastMode: false } });
    expect(env.personaProviders?.coder?.providerOptions).toEqual({ codex: { fastMode: true } });
    expect(env.providerRouting?.tags?.['high-stakes']?.providerOptions)
      .toEqual({ codex: { fastMode: false } });
    expect(env.providerRouting?.steps?.['wf/impl']?.providerOptions)
      .toEqual({ codex: { fastMode: true } });
  });

  it.each([true, false])('keeps config/env provider options separate from runtime profile options (%s)', (envFastMode) => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { fast_mode: false } },
        },
      },
    });
    const previous = process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE;
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE = String(envFastMode);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    try {
      const configProviderOptions = resolveProviderOptionsWithTrace(projectCwd).value;
      const resolved = resolveRuntimeEnvironment({
        projectCwd,
        legacy: { ...legacyInput, providerOptions: configProviderOptions },
        legacySignals: [],
      });

      expect(resolved.providerEnvironment.providerOptions).toEqual({ codex: { fastMode: false } });
      expect(resolved.configProviderOptions?.codex?.fastMode).toBe(envFastMode);
    } finally {
      if (previous === undefined) {
        delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE;
      } else {
        process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE = previous;
      }
      invalidateGlobalConfigCache();
      invalidateAllResolvedConfigCache();
    }
  });

  it('resolves explicit capabilities and permission_mode while leaving omitted profiles unconstrained', () => {
    const providerOptionsDir = join(projectCwd, '.takt', 'provider-options');
    mkdirSync(providerOptionsDir, { recursive: true });
    writeFileSync(join(providerOptionsDir, 'internal-readonly.yaml'), stringifyYaml({
      codex: { network_access: false, skills: { repo: false, user: false } },
    }));
    writeFileSync(join(projectCwd, '.takt', RUNTIME_PROVIDER_FILENAME), stringifyYaml({
      version: 1,
      provider: {
        defaults: { profile: 'plain' },
        profiles: {
          plain: { provider: 'codex', model: 'gpt-default' },
          constrained: {
            provider: 'codex',
            model: 'gpt-review',
            capabilities: 'internal-readonly',
            permission_mode: 'readonly',
          },
        },
        targets: {
          internal_agents: { selector: { profile: 'constrained' } },
        },
      },
    }));

    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    expect(env.providerOptions).toBeUndefined();
    expect(env.permissionMode).toBeUndefined();
    expect(env.internalAgents?.selector).toEqual({
      provider: 'codex',
      model: 'gpt-review',
      providerOptions: {
        codex: { networkAccess: false, skills: { repo: false, user: false } },
      },
      permissionMode: 'readonly',
    });
  });

  it.each([
    {
      label: 'the planning persona',
      targets: { personas: { leader: { profile: 'invalid' } } },
      teamLeader: { personaDisplayName: 'leader' },
    },
    {
      label: 'the part persona',
      targets: { personas: { part: { profile: 'invalid' } } },
      teamLeader: { partPersona: 'part' },
    },
    {
      label: 'the inherited part persona',
      targets: { personas: { parent: { profile: 'invalid' } } },
      teamLeader: { personaDisplayName: 'leader' },
    },
    {
      label: 'a generated part step target',
      targets: { steps: { 'team-seam/lead.api': { profile: 'invalid' } } },
      teamLeader: {},
    },
  ])('preflights invalid config_profile options for $label before Team Leader dispatch', ({ targets, teamLeader }) => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default' },
          invalid: { provider: 'codex', model: 'gpt-invalid', options: { config_profile: 'automation-review' } },
        },
        targets,
      },
    });

    const workflow: WorkflowConfig = {
      name: 'team-seam',
      steps: [{
        name: 'lead',
        personaDisplayName: 'parent',
        instruction: 'decompose the task',
        teamLeader: {
          maxConcurrency: 1,
          timeoutMs: 1_000,
          ...teamLeader,
        },
      }],
      initialStep: 'lead',
      maxSteps: 1,
    };

    expect(() => resolveRuntimeEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
      workflow,
    })).toThrow(/config_profile requires permission_control: codex/);
  });

  it('resolves a global profile capability from the global layer instead of a project shadow', () => {
    const capabilityName = 'runtime-profile-origin-proof';
    const globalProviderOptionsDir = join(getGlobalConfigDir(), 'provider-options');
    const projectProviderOptionsDir = join(projectCwd, '.takt', 'provider-options');
    mkdirSync(globalProviderOptionsDir, { recursive: true });
    mkdirSync(projectProviderOptionsDir, { recursive: true });
    writeFileSync(join(globalProviderOptionsDir, `${capabilityName}.yaml`), stringifyYaml({
      codex: { network_access: false },
    }));
    writeFileSync(join(projectProviderOptionsDir, `${capabilityName}.yaml`), stringifyYaml({
      codex: { network_access: true },
    }));
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'global-profile' },
        profiles: {
          'global-profile': {
            provider: 'codex',
            model: 'gpt-default',
            capabilities: capabilityName,
          },
        },
      },
    });

    try {
      const env = resolveCompiledProviderEnvironment({
        projectCwd,
        legacy: legacyInput,
        legacySignals: [],
      });
      expect(env.providerOptions).toEqual({ codex: { networkAccess: false } });
    } finally {
      rmSync(join(globalProviderOptionsDir, `${capabilityName}.yaml`), { force: true });
    }
  });

  it('skips companion target semantic resolution when companion is disabled', () => {
    writeGlobalRuntimeFile({
      version: 1,
      companion: { enabled: false, review_mode: 'live' },
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-default' } },
        targets: {
          companions: { missing: { profile: 'missing-profile' } },
        },
      },
    });

    const resolved = resolveRuntimeEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    expect(resolved.companionEnabled).toBe(false);
    expect(companionReviewMode(resolved)).toBe('live');
    expect(resolved.providerEnvironment.provider).toBe('codex');
    expect(resolved.providerEnvironment.companions).toBeUndefined();
  });

  it('does not re-enable a globally disabled companion policy from project runtime.yaml', () => {
    writeGlobalRuntimeFile({
      version: 1,
      companion: { enabled: false },
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'global-model' } },
      },
    });
    writeFileSync(join(projectCwd, '.takt', RUNTIME_PROVIDER_FILENAME), stringifyYaml({
      version: 1,
      companion: { enabled: true },
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'project-model' } },
      },
    }));

    const resolved = resolveRuntimeEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    expect(resolved.companionEnabled).toBe(false);
    expect(resolved.providerEnvironment.model).toBe('project-model');
  });

  it('resolves project review_mode over global while preserving the companion enabled AND', () => {
    writeGlobalRuntimeFile({
      version: 1,
      companion: { enabled: false, review_mode: 'live' },
      provider: {
        defaults: { profile: 'global' },
        profiles: { global: { provider: 'codex', model: 'global-model' } },
      },
    });
    writeFileSync(join(projectCwd, '.takt', RUNTIME_PROVIDER_FILENAME), stringifyYaml({
      version: 1,
      companion: { enabled: true, review_mode: 'completion' },
      provider: {
        defaults: { profile: 'project' },
        profiles: { project: { provider: 'codex', model: 'project-model' } },
      },
    }));

    const resolved = resolveRuntimeEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    expect(companionReviewMode(resolved)).toBe('completion');
    expect(resolved.companionEnabled).toBe(false);
  });

  it('does not activate runtime-v1 mode for a disabled companion-only target', () => {
    writeGlobalRuntimeFile({
      version: 1,
      companion: { enabled: false },
      provider: {
        targets: {
          companions: { security: { profile: 'missing-profile' } },
        },
      },
    });

    const resolved = resolveRuntimeEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    expect(resolved.companionEnabled).toBe(false);
    expect(resolved.providerEnvironment.providerSource).toBe('global');
    expect(resolved.providerEnvironment.provider).toBe('codex');
  });

  it('rejects an enabled companion-only target without defaults before compilation', () => {
    writeGlobalRuntimeFile({
      version: 1,
      companion: { enabled: true },
      provider: {
        targets: {
          companions: { security: { profile: 'security' } },
        },
      },
    });

    expect(() => resolveRuntimeEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    })).toThrow(/provider\.defaults/);
  });

  it('passes legacy engine-options through unchanged when no runtime.yaml exists', () => {
    const resolved = resolveRuntimeEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    const env = resolved.providerEnvironment;
    expect(resolved.companionEnabled).toBe(false);
    expect(companionReviewMode(resolved)).toBe('completion');
    expect(env.provider).toBe('codex');
    expect(env.providerSource).toBe('global');
    expect(env.model).toBe('gpt-x');
    expect(env.tagConflictPolicy).toBe('last-wins');
  });

  it('treats an inactive version-only runtime.yaml as legacy', () => {
    writeGlobalRuntimeFile({ version: 1 });

    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    expect(env.providerSource).toBe('global');
    expect(env.tagConflictPolicy).toBe('last-wins');
  });

  it('preserves legacy provider/model resolution when runtime.yaml activates MCP alone', () => {
    writeGlobalRuntimeFile({
      version: 1,
      mcp: {
        servers: { tools: { type: 'stdio', command: 'tools-mcp' } },
        defaults: { servers: ['tools'] },
      },
    });

    const resolved = resolveRuntimeEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    expect(resolved.providerEnvironment.provider).toBe('codex');
    expect(resolved.providerEnvironment.model).toBe('gpt-x');
    expect(resolved.providerEnvironment.providerSource).toBe('global');
    expect(resolved.providerEnvironment.mcpAssignment?.servers?.tools).toEqual({
      type: 'stdio',
      command: 'tools-mcp',
      args: undefined,
      env: undefined,
    });
  });

  it('re-applies a CLI provider override on a runtime-v1 environment, dropping runtime model/options', () => {
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

    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: {
        ...legacyInput,
        provider: 'claude',
        providerSource: 'cli',
        model: undefined,
        modelSource: 'default',
      },
      legacySignals: [],
    });

    expect(env.provider).toBe('claude');
    expect(env.providerSource).toBe('cli');
    expect(env.model).toBeUndefined();
    expect(env.providerOptions).toBeUndefined();
    expect(env.permissionMode).toBeUndefined();
  });

  it('re-applies a CLI provider+model override on a runtime-v1 environment', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-default' } },
      },
    });

    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: {
        ...legacyInput,
        provider: 'claude',
        providerSource: 'cli',
        model: 'sonnet',
        modelSource: 'cli',
      },
      legacySignals: [],
    });

    expect(env.provider).toBe('claude');
    expect(env.providerSource).toBe('cli');
    expect(env.model).toBe('sonnet');
    expect(env.modelSource).toBe('cli');
  });

  it('keeps the runtime provider/options when only the model is overridden', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: { provider: 'codex', model: 'gpt-default', options: { reasoning_effort: 'high' } },
        },
      },
    });

    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: {
        ...legacyInput,
        // provider not overridden (schema default), only model comes from the CLI.
        provider: 'claude',
        providerSource: 'default',
        model: 'my-model',
        modelSource: 'cli',
      },
      legacySignals: [],
    });

    expect(env.provider).toBe('codex');
    expect(env.providerSource).toBe('runtime-v1');
    expect(env.model).toBe('my-model');
    expect(env.modelSource).toBe('cli');
    expect(env.providerOptions).toEqual({ codex: { reasoningEffort: 'high' } });
  });

  it('leaves the runtime-v1 default untouched when provider/model are non-override sources', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-default' } },
      },
    });

    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: {
        ...legacyInput,
        // A schema-injected default is not an override and must not replace the runtime provider.
        provider: 'claude',
        providerSource: 'default',
        model: 'sonnet',
        modelSource: 'default',
      },
      legacySignals: [],
    });

    expect(env.provider).toBe('codex');
    expect(env.providerSource).toBe('runtime-v1');
    expect(env.model).toBe('gpt-default');
    expect(env.modelSource).toBe('runtime-v1');
  });

  it('fails fast when an active runtime section coexists with legacy signals', () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-default' } },
      },
    });

    const legacySignals: LegacyProviderSignal[] = [
      {
        setting: 'provider',
        location: 'config.yaml:provider (global)',
        migrateTo: 'provider.defaults + provider.profiles',
      },
    ];

    expect(() =>
      resolveCompiledProviderEnvironment({
        projectCwd,
        legacy: legacyInput,
        legacySignals,
      }),
    ).toThrow(/config\.yaml:provider \(global\).*provider\.defaults \+ provider\.profiles/s);
  });
});

/**
 * End-to-end coverage for the runtime.yaml `ladder` promotion seam (issue #1208, FAM-1). The
 * two single-unit ladder suites verify the ends in isolation — `ladder-environment.test.ts`
 * compiles an in-memory section, `ladder-runtime.test.ts` hand-injects `providerLadders` into a
 * mocked resolver. Neither exercises the file → compiled environment → real WorkflowEngine →
 * promotion path, so a middle hop dropping `providerLadders` to `undefined` (a same-type silent
 * drop tsc cannot catch) would leave every test green. These tests connect both ends through the
 * real filesystem and a real engine: the compiled `env` (not a mock) is handed to WorkflowEngine,
 * and a target-less `{at:2}` promotion must advance the step from ladder stage 0 to stage 1.
 */

const LADDER_MAIN_ENTRY = { provider: 'opencode', model: 'ollama-cloud/glm-5.2' };
const LADDER_STRONG_ENTRY = { provider: 'claude', model: 'opus' };

/** A runtime-v1 section whose `fix` step routes through a two-stage `ladder`. */
const LADDER_RUNTIME_SECTION = {
  version: 1,
  provider: {
    defaults: { profile: 'base' },
    profiles: {
      base: { provider: 'mock', model: 'base-model' },
      main: LADDER_MAIN_ENTRY,
      strong: LADDER_STRONG_ENTRY,
    },
    targets: {
      steps: { fix: { ladder: ['main', 'strong'] } },
    },
  },
};

function withPromotion(step: WorkflowStep, promotion: Array<{ at?: number }>): WorkflowStep {
  return { ...step, promotion } as WorkflowStep;
}

function makeStructuredCaller(evaluateCondition: ReturnType<typeof vi.fn>): StructuredCaller {
  return { evaluateCondition } as unknown as StructuredCaller;
}

describe('providerLadders end-to-end from runtime.yaml (issue #1208)', () => {
  let ladderProjectCwd: string;
  let engineTmpDir: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    ladderProjectCwd = mkdtempSync(join(tmpdir(), 'takt-seam-ladder-'));
    mkdirSync(join(ladderProjectCwd, '.takt'), { recursive: true });
    engineTmpDir = createTestTmpDir();
    writeGlobalRuntimeFile(LADDER_RUNTIME_SECTION);
  });

  afterEach(() => {
    if (engine) {
      cleanupWorkflowEngine(engine);
      engine = undefined;
    }
    rmSync(ladderProjectCwd, { recursive: true, force: true });
    rmSync(engineTmpDir, { recursive: true, force: true });
  });

  it('should surface every ladder stage and the stage-0 routing entry when a real runtime.yaml declares a ladder', () => {
    const env = resolveCompiledProviderEnvironment({
      projectCwd: ladderProjectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    // Generation-side drop guard: the environment compiler must carry ALL ladder stages through
    // to `providerLadders`, and the stage-0 assignment through to `providerRouting.steps`. If the
    // compiler dropped `providerLadders` to undefined, the promotion seam below would have nothing
    // to advance.
    expect(env.providerLadders?.steps?.fix).toEqual([LADDER_MAIN_ENTRY, LADDER_STRONG_ENTRY]);
    expect(env.providerRouting?.steps?.fix).toEqual(LADDER_MAIN_ENTRY);
    // Stage 0 stays independent of the default profile (`base`), which is what promotion advances from.
    expect(env.provider).toBe('mock');
    expect(env.model).toBe('base-model');
  });

  it('should advance a target-less {at:N} promotion along the runtime.yaml ladder when run inside a real WorkflowEngine', async () => {
    const env = resolveCompiledProviderEnvironment({
      projectCwd: ladderProjectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

    // The step name must equal the runtime.yaml `targets.steps` key: `resolveStepProviderModel`
    // looks up `providerRouting.steps[step.name]` verbatim, and that stage-0 source is what selects
    // the governing ladder for the promotion.
    const fix = withPromotion(
      makeStep('fix', {
        rules: [makeRule('again', 'review'), makeRule('done', 'COMPLETE')],
      }),
      [{ at: 2 }],
    );
    const review = makeStep('review', {
      rules: [makeRule('back', 'fix')],
    });
    const config: WorkflowConfig = {
      name: 'ladder-seam-e2e',
      steps: [fix, review],
      initialStep: 'fix',
      maxSteps: 6,
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'fix', content: 'again' }),
      makeResponse({ persona: 'review', content: 'back' }),
      makeResponse({ persona: 'fix', content: 'done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' }, // fix iteration 1 → review
      { index: 0, method: 'phase3_tag' }, // review → fix
      { index: 1, method: 'phase3_tag' }, // fix iteration 2 → COMPLETE
    ]);

    const evaluateCondition = vi.fn().mockRejectedValue(new Error('AI judge must not run for a ladder promotion'));
    engine = new WorkflowEngine(config, engineTmpDir, 'test task', {
      projectCwd: engineTmpDir,
      provider: env.provider,
      model: env.model,
      providerRouting: env.providerRouting,
      providerLadders: env.providerLadders,
      providerRoutingTagConflictPolicy: env.tagConflictPolicy,
      structuredCaller: makeStructuredCaller(evaluateCondition),
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    // INV-C: a target-less `{at:N}` ladder promotion is deterministic and never calls the AI judge.
    expect(evaluateCondition).not.toHaveBeenCalled();

    const fixIteration1 = vi.mocked(runAgent).mock.calls[0]?.[2];
    const fixIteration2 = vi.mocked(runAgent).mock.calls[2]?.[2];
    // Boundary (stage 0 held): iteration 1 has not reached `{at:2}`, so the ladder's first stage runs.
    expect(fixIteration1).toMatchObject({
      resolvedProvider: 'opencode',
      resolvedModel: 'ollama-cloud/glm-5.2',
    });
    // Promotion (stage 1): iteration 2 reaches `{at:2}`, advancing the governing steps ladder.
    // Falsification: dropping `env.providerLadders` to undefined makes this a no-op and keeps MAIN.
    expect(fixIteration2).toMatchObject({
      resolvedProvider: 'claude',
      resolvedModel: 'opus',
    });
  });
});

describe('runtime provider options through workflow execution', () => {
  let workflowProjectCwd: string;
  let originalFastMode: string | undefined;
  let originalPermissionControl: string | undefined;
  let originalConfigProfile: string | undefined;
  let originalProvider: string | undefined;
  let originalModel: string | undefined;
  let hadGlobalConfig: boolean;
  let originalGlobalConfig: string | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    workflowProjectCwd = mkdtempSync(join(tmpdir(), 'takt-seam-workflow-'));
    mkdirSync(join(workflowProjectCwd, '.takt', 'workflows', 'personas'), { recursive: true });
    const globalConfigPath = getGlobalConfigPath();
    hadGlobalConfig = existsSync(globalConfigPath);
    originalGlobalConfig = hadGlobalConfig
      ? readFileSync(globalConfigPath, 'utf-8')
      : undefined;
    writeFileSync(
      join(workflowProjectCwd, '.takt', 'workflows', 'runtime-provider-handoff.yaml'),
      [
        'name: runtime-provider-handoff',
        'description: runtime provider option handoff integration test',
        'max_steps: 1',
        'initial_step: plan',
        'steps:',
        '  - name: plan',
        '    persona: ./personas/planner.md',
        '    instruction: "{task}"',
        '    rules:',
        '      - condition: when(true)',
        '        next: COMPLETE',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(workflowProjectCwd, '.takt', 'workflows', 'personas', 'planner.md'),
      'You are planner.',
      'utf-8',
    );

    originalFastMode = process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE;
    originalPermissionControl = process.env.TAKT_PROVIDER_OPTIONS_CODEX_PERMISSION_CONTROL;
    originalConfigProfile = process.env.TAKT_PROVIDER_OPTIONS_CODEX_CONFIG_PROFILE;
    originalProvider = process.env.TAKT_PROVIDER;
    originalModel = process.env.TAKT_MODEL;
    delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE;
    delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_PERMISSION_CONTROL;
    delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_CONFIG_PROFILE;
    delete process.env.TAKT_PROVIDER;
    delete process.env.TAKT_MODEL;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    if (originalFastMode === undefined) {
      delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE;
    } else {
      process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE = originalFastMode;
    }
    if (originalPermissionControl === undefined) {
      delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_PERMISSION_CONTROL;
    } else {
      process.env.TAKT_PROVIDER_OPTIONS_CODEX_PERMISSION_CONTROL = originalPermissionControl;
    }
    if (originalConfigProfile === undefined) {
      delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_CONFIG_PROFILE;
    } else {
      process.env.TAKT_PROVIDER_OPTIONS_CODEX_CONFIG_PROFILE = originalConfigProfile;
    }
    if (originalProvider === undefined) {
      delete process.env.TAKT_PROVIDER;
    } else {
      process.env.TAKT_PROVIDER = originalProvider;
    }
    if (originalModel === undefined) {
      delete process.env.TAKT_MODEL;
    } else {
      process.env.TAKT_MODEL = originalModel;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    const globalConfigPath = getGlobalConfigPath();
    if (hadGlobalConfig) {
      writeFileSync(globalConfigPath, originalGlobalConfig!, 'utf-8');
    } else {
      rmSync(globalConfigPath, { force: true });
    }
    rmSync(workflowProjectCwd, { recursive: true, force: true });
  });

  function writeRootQualifiedLadderFixture(
    permissionControl: 'codex' | 'takt',
    targetName = 'runtime-provider-handoff/plan',
  ): void {
    writeFileSync(
      join(workflowProjectCwd, '.takt', 'workflows', 'runtime-provider-handoff.yaml'),
      [
        'name: runtime-provider-handoff',
        'description: runtime provider qualified ladder integration test',
        'max_steps: 2',
        'initial_step: plan',
        'steps:',
        '  - name: plan',
        '    persona: ./personas/planner.md',
        '    instruction: "{task}"',
        '    promotion:',
        '      - at: 2',
        '    rules:',
        '      - condition: again',
        '        next: plan',
        '      - condition: done',
        '        next: COMPLETE',
      ].join('\n'),
      'utf-8',
    );
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'base' },
        profiles: {
          base: { provider: 'opencode', model: 'opencode/qwen' },
          review: {
            provider: 'codex',
            model: 'gpt-review',
            options: { config_profile: 'runtime-review', permission_control: permissionControl },
          },
        },
        targets: {
          steps: { [targetName]: { ladder: ['base', 'review'] } },
        },
      },
    });
  }

  function writeChildQualifiedLadderFixture(permissionControl: 'codex' | 'takt'): void {
    writeFileSync(
      join(workflowProjectCwd, '.takt', 'workflows', 'child-runtime-provider.yaml'),
      [
        'name: child-runtime-provider',
        'subworkflow:',
        '  callable: true',
        'max_steps: 2',
        'initial_step: child-plan',
        'steps:',
        '  - name: child-plan',
        '    persona: ./personas/planner.md',
        '    instruction: "{task}"',
        '    promotion:',
        '      - at: 2',
        '    rules:',
        '      - condition: again',
        '        next: child-plan',
        '      - condition: done',
        '        next: COMPLETE',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(workflowProjectCwd, '.takt', 'workflows', 'runtime-provider-handoff.yaml'),
      [
        'name: runtime-provider-handoff',
        'description: child runtime provider qualified ladder integration test',
        'max_steps: 4',
        'initial_step: before',
        'steps:',
        '  - name: before',
        '    persona: ./personas/planner.md',
        '    instruction: "{task}"',
        '    rules:',
        '      - condition: done',
        '        next: delegate',
        '  - name: delegate',
        '    kind: workflow_call',
        '    call: child-runtime-provider',
        '    rules:',
        '      - condition: COMPLETE',
        '        next: COMPLETE',
      ].join('\n'),
      'utf-8',
    );
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'base' },
        profiles: {
          base: { provider: 'opencode', model: 'opencode/qwen' },
          review: {
            provider: 'codex',
            model: 'gpt-review',
            options: { config_profile: 'runtime-review', permission_control: permissionControl },
          },
        },
        targets: {
          steps: { 'child-runtime-provider/child-plan': { ladder: ['base', 'review'] } },
        },
      },
    });
  }

  function writeLegacyConfigProfile(scope: 'project' | 'global'): void {
    const configPath = scope === 'project'
      ? join(workflowProjectCwd, '.takt', 'config.yaml')
      : getGlobalConfigPath();
    writeFileSync(configPath, stringifyYaml({
      provider_options: { codex: { config_profile: 'automation-review' } },
    }), 'utf-8');
  }

  it.each([
    [false, true],
    [true, false],
  ])(
    'hands the environment winner to workflow consumers (profile=%s, env=%s)',
    async (profileFastMode, envFastMode) => {
      writeGlobalRuntimeFile({
        version: 1,
        provider: {
          defaults: { profile: 'default' },
          profiles: {
            default: {
              provider: 'codex',
              model: 'gpt-runtime',
              options: { fast_mode: profileFastMode },
            },
          },
        },
      });
      process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE = String(envFastMode);
      invalidateGlobalConfigCache();
      invalidateAllResolvedConfigCache();
      mockRunAgentSequence([makeResponse({ persona: 'planner', content: 'done' })]);
      mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

      try {
        const result = await runWorkflowExecution({
          task: 'test runtime provider option handoff',
          cwd: workflowProjectCwd,
          projectCwd: workflowProjectCwd,
          workflowIdentifier: 'runtime-provider-handoff',
          outputMode: 'silent',
        });

        expect(result.success).toBe(true);
        expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
        const agentOptions = vi.mocked(runAgent).mock.calls[0]?.[2];
        expect(agentOptions?.resolvedProviderOptions).toMatchObject({
          codex: { fastMode: envFastMode },
        });

        const ndjsonLogPath = result.ndjsonLogPath;
        expect(ndjsonLogPath).toBeDefined();
        const records = readFileSync(ndjsonLogPath!, 'utf-8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const stepStart = records.find((record) => record.type === 'step_start');
        expect(stepStart).toMatchObject({
          providerOptions: { codex: { fastMode: envFastMode } },
          providerOptionsSources: { 'codex.fastMode': 'env' },
        });
      } finally {
        if (originalFastMode === undefined) {
          delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE;
        } else {
          process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE = originalFastMode;
        }
        invalidateGlobalConfigCache();
        invalidateAllResolvedConfigCache();
      }
    },
  );

  it('allows env config_profile and fast_mode with a runtime Codex provider', async () => {
    writeGlobalRuntimeFile({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: {
          default: {
            provider: 'codex',
            model: 'gpt-runtime',
            options: { permission_control: 'codex' },
          },
        },
      },
    });
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_CONFIG_PROFILE = 'automation-review';
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE = 'true';
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    mockRunAgentSequence([makeResponse({ persona: 'planner', content: 'done' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const result = await runWorkflowExecution({
      task: 'env provider options with runtime provider',
      cwd: workflowProjectCwd,
      projectCwd: workflowProjectCwd,
      workflowIdentifier: 'runtime-provider-handoff',
      outputMode: 'silent',
    });

    expect(result.success).toBe(true);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.resolvedProviderOptions).toMatchObject({
      codex: {
        configProfile: 'automation-review',
        fastMode: true,
        permissionControl: 'codex',
      },
    });
  });

  it.each(['project', 'global'] as const)(
    'rejects %s provider_options when an unrelated env leaf is also present',
    async (scope) => {
      writeGlobalRuntimeFile({
        version: 1,
        provider: {
          defaults: { profile: 'default' },
          profiles: {
            default: {
              provider: 'codex',
              model: 'gpt-runtime',
              options: { permission_control: 'codex' },
            },
          },
        },
      });
      writeLegacyConfigProfile(scope);
      process.env.TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE = 'true';
      invalidateGlobalConfigCache();
      invalidateAllResolvedConfigCache();

      await expect(runWorkflowExecution({
        task: `mixed ${scope} provider options`,
        cwd: workflowProjectCwd,
        projectCwd: workflowProjectCwd,
        workflowIdentifier: 'runtime-provider-handoff',
        outputMode: 'silent',
      })).rejects.toThrow(/Mixed provider configuration[\s\S]*provider_options/);
      expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid runtime Codex profile before any workflow agent starts', async () => {
    writeFileSync(
      join(workflowProjectCwd, '.takt', RUNTIME_PROVIDER_FILENAME),
      stringifyYaml({
        version: 1,
        provider: {
          defaults: { profile: 'default' },
          profiles: {
            default: {
              provider: 'codex',
              model: 'gpt-runtime',
              options: { config_profile: 'runtime-review' },
            },
          },
        },
      }),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_PERMISSION_CONTROL = 'takt';
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    await expect(runWorkflowExecution({
      task: 'invalid runtime provider options',
      cwd: workflowProjectCwd,
      projectCwd: workflowProjectCwd,
      workflowIdentifier: 'runtime-provider-handoff',
      outputMode: 'silent',
    })).rejects.toThrow(/config_profile requires permission_control: codex/);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('rejects an invalid runtime Codex profile selected by a workflow step target before execution', async () => {
    writeFileSync(
      join(workflowProjectCwd, '.takt', RUNTIME_PROVIDER_FILENAME),
      stringifyYaml({
        version: 1,
        provider: {
          defaults: { profile: 'default' },
          profiles: {
            default: { provider: 'opencode', model: 'opencode/qwen' },
            review: {
              provider: 'codex',
              model: 'gpt-review',
              options: { config_profile: 'runtime-review' },
            },
          },
          targets: {
            steps: { 'runtime-provider-handoff/plan': { profile: 'review' } },
          },
        },
      }),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    await expect(runWorkflowExecution({
      task: 'invalid routed runtime provider options',
      cwd: workflowProjectCwd,
      projectCwd: workflowProjectCwd,
      workflowIdentifier: 'runtime-provider-handoff',
      outputMode: 'silent',
    })).rejects.toThrow(/config_profile requires permission_control: codex/);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('rejects an invalid runtime Codex profile selected by a child workflow step before execution', async () => {
    writeFileSync(
      join(workflowProjectCwd, '.takt', 'workflows', 'child-runtime-provider.yaml'),
      [
        'name: child-runtime-provider',
        'subworkflow:',
        '  callable: true',
        'max_steps: 1',
        'initial_step: child-plan',
        'steps:',
        '  - name: child-plan',
        '    persona: ./personas/planner.md',
        '    instruction: "{task}"',
        '    rules:',
        '      - condition: when(true)',
        '        next: COMPLETE',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(workflowProjectCwd, '.takt', 'workflows', 'runtime-provider-handoff.yaml'),
      [
        'name: runtime-provider-handoff',
        'description: runtime provider option handoff integration test',
        'max_steps: 1',
        'initial_step: delegate',
        'steps:',
        '  - name: delegate',
        '    kind: workflow_call',
        '    call: child-runtime-provider',
        '    rules:',
        '      - condition: COMPLETE',
        '        next: COMPLETE',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(workflowProjectCwd, '.takt', RUNTIME_PROVIDER_FILENAME),
      stringifyYaml({
        version: 1,
        provider: {
          defaults: { profile: 'default' },
          profiles: {
            default: { provider: 'opencode', model: 'opencode/qwen' },
            childReview: {
              provider: 'codex',
              model: 'gpt-review',
              options: { config_profile: 'runtime-review' },
            },
          },
          targets: {
            steps: { 'child-runtime-provider/child-plan': { profile: 'childReview' } },
          },
        },
      }),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    await expect(runWorkflowExecution({
      task: 'invalid child workflow runtime provider options',
      cwd: workflowProjectCwd,
      projectCwd: workflowProjectCwd,
      workflowIdentifier: 'runtime-provider-handoff',
      outputMode: 'silent',
    })).rejects.toThrow(/config_profile requires permission_control: codex/);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('rejects an invalid runtime Codex profile for a loop judge before execution', async () => {
    writeFileSync(
      join(workflowProjectCwd, '.takt', 'workflows', 'runtime-provider-handoff.yaml'),
      [
        'name: runtime-provider-handoff',
        'description: runtime provider option handoff integration test',
        'max_steps: 2',
        'initial_step: plan',
        'steps:',
        '  - name: plan',
        '    persona: ./personas/planner.md',
        '    instruction: "{task}"',
        '    rules:',
        '      - condition: when(true)',
        '        next: COMPLETE',
        '  - name: review',
        '    persona: ./personas/planner.md',
        '    instruction: "{task}"',
        '    rules:',
        '      - condition: when(true)',
        '        next: COMPLETE',
        'loop_monitors:',
        '  - cycle: [plan, review]',
        '    threshold: 1',
        '    judge:',
        '      rules:',
        '        - condition: when(true)',
        '          next: COMPLETE',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(workflowProjectCwd, '.takt', RUNTIME_PROVIDER_FILENAME),
      stringifyYaml({
        version: 1,
        provider: {
          defaults: { profile: 'default' },
          profiles: {
            default: { provider: 'opencode', model: 'opencode/qwen' },
            judge: {
              provider: 'codex',
              model: 'gpt-judge',
              options: { config_profile: 'runtime-judge' },
            },
          },
          targets: { internal_agents: { 'loop-judge': { profile: 'judge' } } },
        },
      }),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    await expect(runWorkflowExecution({
      task: 'invalid loop judge runtime provider options',
      cwd: workflowProjectCwd,
      projectCwd: workflowProjectCwd,
      workflowIdentifier: 'runtime-provider-handoff',
      outputMode: 'silent',
    })).rejects.toThrow(/config_profile requires permission_control: codex/);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('rejects an invalid runtime Codex profile for a completion-retry judge before execution', async () => {
    writeFileSync(
      join(workflowProjectCwd, '.takt', 'workflows', 'runtime-provider-handoff.yaml'),
      [
        'name: runtime-provider-handoff',
        'description: runtime provider option handoff integration test',
        'max_steps: 1',
        'initial_step: plan',
        'steps:',
        '  - name: plan',
        '    persona: ./personas/planner.md',
        '    instruction: "{task}"',
        '    completion_retry:',
        '      retry_instruction: retry',
        '    rules:',
        '      - condition: when(true)',
        '        next: COMPLETE',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(workflowProjectCwd, '.takt', RUNTIME_PROVIDER_FILENAME),
      stringifyYaml({
        version: 1,
        provider: {
          defaults: { profile: 'default' },
          profiles: {
            default: { provider: 'opencode', model: 'opencode/qwen' },
            judge: {
              provider: 'codex',
              model: 'gpt-review',
              options: { config_profile: 'runtime-review' },
            },
          },
          targets: {
            internal_agents: { 'review-completion-judge': { profile: 'judge' } },
          },
        },
      }),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    await expect(runWorkflowExecution({
      task: 'invalid completion retry judge runtime provider options',
      cwd: workflowProjectCwd,
      projectCwd: workflowProjectCwd,
      workflowIdentifier: 'runtime-provider-handoff',
      outputMode: 'silent',
    })).rejects.toThrow(/config_profile requires permission_control: codex/);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('accepts a runtime Codex profile when env supplies permission_control=codex', async () => {
    writeFileSync(
      join(workflowProjectCwd, '.takt', RUNTIME_PROVIDER_FILENAME),
      stringifyYaml({
        version: 1,
        provider: {
          defaults: { profile: 'default' },
          profiles: {
            default: {
              provider: 'codex',
              model: 'gpt-runtime',
              options: { config_profile: 'runtime-review' },
            },
          },
        },
      }),
      'utf-8',
    );
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_PERMISSION_CONTROL = 'codex';
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    mockRunAgentSequence([makeResponse({ persona: 'planner', content: 'done' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const result = await runWorkflowExecution({
      task: 'valid runtime provider options',
      cwd: workflowProjectCwd,
      projectCwd: workflowProjectCwd,
      workflowIdentifier: 'runtime-provider-handoff',
      outputMode: 'silent',
    });

    expect(result.success).toBe(true);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.resolvedProviderOptions).toMatchObject({
      codex: {
        configProfile: 'runtime-review',
        permissionControl: 'codex',
      },
    });
  });

  it('accepts a valid root qualified runtime ladder before promotion dispatch', async () => {
    writeRootQualifiedLadderFixture('codex');
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    mockRunAgentSequence([
      makeResponse({ persona: 'planner', content: 'again' }),
      makeResponse({ persona: 'planner', content: 'done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 1, method: 'phase3_tag' },
    ]);

    const result = await runWorkflowExecution({
      task: 'valid root qualified ladder provider options',
      cwd: workflowProjectCwd,
      projectCwd: workflowProjectCwd,
      workflowIdentifier: 'runtime-provider-handoff',
      outputMode: 'silent',
    });

    expect(result.success).toBe(true);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent).mock.calls[1]?.[2]?.resolvedProviderOptions).toMatchObject({
      codex: {
        configProfile: 'runtime-review',
        permissionControl: 'codex',
      },
    });
  });

  it('rejects an invalid root qualified runtime ladder before the first agent starts', async () => {
    writeRootQualifiedLadderFixture('takt');
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    mockRunAgentSequence([
      makeResponse({ persona: 'planner', content: 'again' }),
      makeResponse({ persona: 'planner', content: 'done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 1, method: 'phase3_tag' },
    ]);

    await expect(runWorkflowExecution({
      task: 'invalid root qualified ladder provider options',
      cwd: workflowProjectCwd,
      projectCwd: workflowProjectCwd,
      workflowIdentifier: 'runtime-provider-handoff',
      outputMode: 'silent',
    })).rejects.toThrow(/config_profile requires permission_control: codex/);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('does not validate a qualified ladder for another workflow', async () => {
    writeRootQualifiedLadderFixture('takt', 'other/fix');
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    mockRunAgentSequence([
      makeResponse({ persona: 'planner', content: 'again' }),
      makeResponse({ persona: 'planner', content: 'done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 1, method: 'phase3_tag' },
    ]);

    const result = await runWorkflowExecution({
      task: 'non-selected qualified ladder provider options',
      cwd: workflowProjectCwd,
      projectCwd: workflowProjectCwd,
      workflowIdentifier: 'runtime-provider-handoff',
      outputMode: 'silent',
    });

    expect(result.success).toBe(true);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent).mock.calls[1]?.[2]?.resolvedProviderOptions).not.toMatchObject({
      codex: { configProfile: 'runtime-review' },
    });
  });

  it('accepts a valid child qualified runtime ladder before promotion dispatch', async () => {
    writeChildQualifiedLadderFixture('codex');
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    mockRunAgentSequence([
      makeResponse({ persona: 'planner', content: 'done' }),
      makeResponse({ persona: 'planner', content: 'again' }),
      makeResponse({ persona: 'planner', content: 'done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 1, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    const result = await runWorkflowExecution({
      task: 'valid child qualified ladder provider options',
      cwd: workflowProjectCwd,
      projectCwd: workflowProjectCwd,
      workflowIdentifier: 'runtime-provider-handoff',
      outputMode: 'silent',
    });

    expect(result.success).toBe(true);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(runAgent).mock.calls[2]?.[2]?.resolvedProviderOptions).toMatchObject({
      codex: {
        configProfile: 'runtime-review',
        permissionControl: 'codex',
      },
    });
  });

  it('rejects an invalid child qualified runtime ladder before the parent agent starts', async () => {
    writeChildQualifiedLadderFixture('takt');
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    mockRunAgentSequence([
      makeResponse({ persona: 'planner', content: 'done' }),
      makeResponse({ persona: 'planner', content: 'again' }),
      makeResponse({ persona: 'planner', content: 'done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 1, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    await expect(runWorkflowExecution({
      task: 'invalid child qualified ladder provider options',
      cwd: workflowProjectCwd,
      projectCwd: workflowProjectCwd,
      workflowIdentifier: 'runtime-provider-handoff',
      outputMode: 'silent',
    })).rejects.toThrow(/config_profile requires permission_control: codex/);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('validates a consumable runtime ladder stage after composing base options', async () => {
    writeFileSync(
      join(workflowProjectCwd, '.takt', 'workflows', 'runtime-provider-handoff.yaml'),
      [
        'name: runtime-provider-handoff',
        'description: runtime provider ladder validation integration test',
        'max_steps: 4',
        'initial_step: fix',
        'steps:',
        '  - name: fix',
        '    persona: ./personas/planner.md',
        '    instruction: "{task}"',
        '    promotion:',
        '      - at: 2',
        '    rules:',
        '      - condition: again',
        '        next: review',
        '      - condition: done',
        '        next: COMPLETE',
        '  - name: review',
        '    persona: ./personas/planner.md',
        '    instruction: "{task}"',
        '    rules:',
        '      - condition: back',
        '        next: fix',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(workflowProjectCwd, '.takt', RUNTIME_PROVIDER_FILENAME),
      stringifyYaml({
        version: 1,
        provider: {
          defaults: { ladder: ['base', 'review'] },
          profiles: {
            base: { provider: 'codex', model: 'gpt-base' },
            review: {
              provider: 'codex',
              model: 'gpt-review',
              options: {
                config_profile: 'automation-review',
                permission_control: 'codex',
              },
            },
          },
        },
      }),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    mockRunAgentSequence([
      makeResponse({ persona: 'fix', content: 'again' }),
      makeResponse({ persona: 'review', content: 'back' }),
      makeResponse({ persona: 'fix', content: 'done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 1, method: 'phase3_tag' },
    ]);

    const result = await runWorkflowExecution({
      task: 'valid runtime ladder provider options',
      cwd: workflowProjectCwd,
      projectCwd: workflowProjectCwd,
      workflowIdentifier: 'runtime-provider-handoff',
      outputMode: 'silent',
    });

    expect(result.success).toBe(true);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(runAgent).mock.calls[2]?.[2]?.resolvedProviderOptions).toMatchObject({
      codex: {
        configProfile: 'automation-review',
        permissionControl: 'codex',
      },
    });
  });

  it('rejects an invalid consumable runtime ladder stage before the first agent starts', async () => {
    writeFileSync(
      join(workflowProjectCwd, '.takt', 'workflows', 'runtime-provider-handoff.yaml'),
      [
        'name: runtime-provider-handoff',
        'description: runtime provider ladder validation integration test',
        'max_steps: 4',
        'initial_step: fix',
        'steps:',
        '  - name: fix',
        '    persona: ./personas/planner.md',
        '    instruction: "{task}"',
        '    promotion:',
        '      - at: 2',
        '    rules:',
        '      - condition: again',
        '        next: review',
        '      - condition: done',
        '        next: COMPLETE',
        '  - name: review',
        '    persona: ./personas/planner.md',
        '    instruction: "{task}"',
        '    rules:',
        '      - condition: back',
        '        next: fix',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(workflowProjectCwd, '.takt', RUNTIME_PROVIDER_FILENAME),
      stringifyYaml({
        version: 1,
        provider: {
          defaults: { ladder: ['base', 'review'] },
          profiles: {
            base: { provider: 'codex', model: 'gpt-base' },
            review: {
              provider: 'codex',
              model: 'gpt-review',
              options: {
                config_profile: 'automation-review',
                permission_control: 'takt',
              },
            },
          },
        },
      }),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    await expect(runWorkflowExecution({
      task: 'invalid runtime ladder provider options',
      cwd: workflowProjectCwd,
      projectCwd: workflowProjectCwd,
      workflowIdentifier: 'runtime-provider-handoff',
      outputMode: 'silent',
    })).rejects.toThrow(/config_profile requires permission_control: codex/);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });
});
