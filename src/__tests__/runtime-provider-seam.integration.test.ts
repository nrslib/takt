import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import {
  resolveCompiledProviderEnvironment,
  resolveRuntimeEnvironment,
} from '../infra/config/runtime-provider/provider-environment.js';
import type { LegacyProviderEnvironmentInput } from '../infra/config/runtime-provider/environment.js';
import type { LegacyProviderSignal } from '../infra/config/runtime-provider/mode.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
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
      companion: { enabled: false },
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

  it('passes legacy engine-options through unchanged when no runtime.yaml exists', () => {
    const env = resolveCompiledProviderEnvironment({
      projectCwd,
      legacy: legacyInput,
      legacySignals: [],
    });

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
