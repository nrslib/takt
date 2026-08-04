import { describe, expect, it } from 'vitest';
import {
  compileProviderEnvironment,
  compileLegacyProviderEnvironment,
  compileRuntimeProviderEnvironment,
  type LegacyProviderEnvironmentInput,
} from '../infra/config/runtime-provider/environment.js';
import { collectLegacyProviderSignals } from '../infra/config/runtime-provider/legacy-signals.js';
import type { RuntimeProviderSection } from '../infra/config/runtime-provider/schema.js';

/**
 * Contracts covered (Unit A / issue #1136):
 * - Legacy compiler passes the resolved engine-options through unchanged (byte-identical funnel).
 * - Runtime compiler maps `defaults.profile` -> provider/model with the `runtime-v1` source,
 *   and `targets.personas/tags/steps` -> personaProviders / providerRouting (order.md ladder).
 * - Runtime compiler wires the remaining features into the bundle: profile `options` become
 *   provider-specific options, `pool`/`auto_routing` become an `AutoRoutingConfig`, and
 *   `internal_agents` targets become the `internalAgents` entry.
 * - Structural inconsistencies (unknown references, missing tier/fallback, internal_agents pool
 *   or unknown key) fail fast before any agent runs.
 * - The factory selects the compiler by the discriminated union `kind`.
 */

const legacyInput: LegacyProviderEnvironmentInput = {
  provider: 'codex',
  providerSource: 'global',
  model: 'gpt-x',
  modelSource: 'global',
  personaProviders: { coder: { provider: 'claude' } },
  providerRouting: { steps: { 'wf/impl': { provider: 'opencode' } } },
  autoRouting: undefined,
  providerOptions: undefined,
};

describe('compileLegacyProviderEnvironment', () => {
  it('passes the resolved legacy engine-options through unchanged', () => {
    const env = compileLegacyProviderEnvironment(legacyInput);
    expect(env).toEqual({
      provider: 'codex',
      providerSource: 'global',
      model: 'gpt-x',
      modelSource: 'global',
      personaProviders: { coder: { provider: 'claude' } },
      providerRouting: { steps: { 'wf/impl': { provider: 'opencode' } } },
      autoRouting: undefined,
      providerOptions: undefined,
      tagConflictPolicy: 'last-wins',
    });
  });

  it('is selected by the factory for kind: legacy', () => {
    expect(compileProviderEnvironment({ kind: 'legacy', legacy: legacyInput }))
      .toEqual(compileLegacyProviderEnvironment(legacyInput));
  });
});

describe('compileRuntimeProviderEnvironment (profile path)', () => {
  it('maps defaults.profile to provider/model with the runtime-v1 source', () => {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'default' },
      profiles: { default: { provider: 'codex', model: 'gpt-x' } },
    };
    const env = compileRuntimeProviderEnvironment(section);
    expect(env.provider).toBe('codex');
    expect(env.model).toBe('gpt-x');
    expect(env.providerSource).toBe('runtime-v1');
    expect(env.modelSource).toBe('runtime-v1');
    expect(env.tagConflictPolicy).toBe('fail-fast');
  });

  it('maps persona/tag/step targets onto the engine ladder fields', () => {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'base' },
      profiles: {
        base: { provider: 'codex', model: 'base-m' },
        p: { provider: 'claude', model: 'persona-m' },
        t: { provider: 'opencode', model: 'tag-m' },
        s: { provider: 'cursor', model: 'step-m' },
      },
      targets: {
        personas: { coder: { profile: 'p' } },
        tags: { 'high-stakes': { profile: 't' } },
        steps: { 'wf/impl': { profile: 's' } },
      },
    };
    const env = compileRuntimeProviderEnvironment(section);
    expect(env.personaProviders).toEqual({ coder: { provider: 'claude', model: 'persona-m' } });
    expect(env.providerRouting).toEqual({
      tags: { 'high-stakes': { provider: 'opencode', model: 'tag-m' } },
      steps: { 'wf/impl': { provider: 'cursor', model: 'step-m' } },
    });
  });

  it('resolves extends chains before mapping', () => {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'child' },
      profiles: {
        parent: { provider: 'codex', model: 'inherited-m' },
        child: { extends: 'parent' },
      },
    };
    const env = compileRuntimeProviderEnvironment(section);
    expect(env.provider).toBe('codex');
    expect(env.model).toBe('inherited-m');
  });
});

describe('compileRuntimeProviderEnvironment (profile options)', () => {
  it('nests a flat profile options bag under the profile provider on defaults', () => {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'p' },
      profiles: { p: { provider: 'codex', model: 'm', options: { reasoning_effort: 'high' } } },
    };
    const env = compileRuntimeProviderEnvironment(section);
    expect(env.providerOptions).toEqual({ codex: { reasoningEffort: 'high' } });
  });

  it('carries profile options onto persona/tag/step routing entries', () => {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'base' },
      profiles: {
        base: { provider: 'codex', model: 'base-m' },
        p: { provider: 'codex', model: 'persona-m', options: { reasoning_effort: 'low' } },
      },
      targets: { personas: { coder: { profile: 'p' } } },
    };
    const env = compileRuntimeProviderEnvironment(section);
    expect(env.personaProviders).toEqual({
      coder: { provider: 'codex', model: 'persona-m', providerOptions: { codex: { reasoningEffort: 'low' } } },
    });
  });
});

describe('compileRuntimeProviderEnvironment (auto routing)', () => {
  it('compiles defaults.pool + auto_routing into an AutoRoutingConfig referencing profiles', () => {
    const section: RuntimeProviderSection = {
      defaults: { pool: 'sol-pool' },
      profiles: {
        'sol-high': { provider: 'codex', model: 'gpt-h', options: { reasoning_effort: 'high' } },
        'sol-low': { provider: 'codex', model: 'gpt-l' },
        router: { provider: 'codex', model: 'gpt-r' },
      },
      auto_routing: {
        strategy: 'balanced',
        router_profile: 'router',
        pools: {
          'sol-pool': {
            candidates: [
              { profile: 'sol-high', tier: 'high' },
              { profile: 'sol-low', tier: 'low' },
            ],
            fallback_profile: 'sol-high',
          },
        },
      },
    };
    const env = compileRuntimeProviderEnvironment(section);
    expect(env.provider).toBeUndefined();
    expect(env.model).toBeUndefined();
    expect(env.autoRouting).toEqual({
      strategy: 'balanced',
      router: { provider: 'codex', model: 'gpt-r' },
      candidates: [
        { name: 'sol-high', provider: 'codex', model: 'gpt-h', routingTier: 'high', providerOptions: { codex: { reasoningEffort: 'high' } } },
        { name: 'sol-low', provider: 'codex', model: 'gpt-l', routingTier: 'low' },
      ],
      defaultPool: 'sol-pool',
      candidatePools: { 'sol-pool': { candidates: ['sol-high', 'sol-low'], fallback: 'sol-high' } },
    });
  });

  it('maps target pool assignments to poolRules and defaults the strategy to balanced', () => {
    const section: RuntimeProviderSection = {
      defaults: { pool: 'p1' },
      profiles: {
        a: { provider: 'codex', model: 'ma' },
        b: { provider: 'codex', model: 'mb' },
        router: { provider: 'codex', model: 'mr' },
      },
      targets: { steps: { 'wf/impl': { pool: 'p2' } } },
      auto_routing: {
        router_profile: 'router',
        pools: {
          p1: { candidates: [{ profile: 'a', tier: 'low' }], fallback_profile: 'a' },
          p2: { candidates: [{ profile: 'b', tier: 'high' }], fallback_profile: 'b' },
        },
      },
    };
    const env = compileRuntimeProviderEnvironment(section);
    expect(env.autoRouting?.strategy).toBe('balanced');
    expect(env.autoRouting?.defaultPool).toBe('p1');
    expect(env.autoRouting?.poolRules).toEqual({ steps: { 'wf/impl': 'p2' } });
  });

  it('throws when auto_routing is configured but defaults does not use a pool', () => {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'a' },
      profiles: { a: { provider: 'codex', model: 'm' }, router: { provider: 'codex', model: 'r' } },
      auto_routing: {
        router_profile: 'router',
        pools: { p: { candidates: [{ profile: 'a', tier: 'low' }], fallback_profile: 'a' } },
      },
    };
    expect(() => compileRuntimeProviderEnvironment(section)).toThrow(/defaults.*pool/);
  });

  it('throws when a pool candidate is missing a tier', () => {
    const section: RuntimeProviderSection = {
      defaults: { pool: 'p' },
      profiles: { a: { provider: 'codex', model: 'm' }, router: { provider: 'codex', model: 'r' } },
      auto_routing: {
        router_profile: 'router',
        pools: { p: { candidates: [{ profile: 'a' }], fallback_profile: 'a' } },
      },
    };
    expect(() => compileRuntimeProviderEnvironment(section)).toThrow(/tier/);
  });

  it('throws when a pool fallback_profile is not among the pool candidates', () => {
    const section: RuntimeProviderSection = {
      defaults: { pool: 'p' },
      profiles: {
        a: { provider: 'codex', model: 'm' },
        b: { provider: 'codex', model: 'm2' },
        router: { provider: 'codex', model: 'r' },
      },
      auto_routing: {
        router_profile: 'router',
        pools: { p: { candidates: [{ profile: 'a', tier: 'low' }], fallback_profile: 'b' } },
      },
    };
    expect(() => compileRuntimeProviderEnvironment(section)).toThrow(/fallback_profile/);
  });
});

describe('compileRuntimeProviderEnvironment (internal agents)', () => {
  it('resolves internal_agents selector/assistant profiles into the internalAgents bundle', () => {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'base' },
      profiles: {
        base: { provider: 'codex', model: 'base-m' },
        router: { provider: 'codex', model: 'r', options: { reasoning_effort: 'high' } },
      },
      targets: { internal_agents: { selector: { profile: 'router' } } },
    };
    const env = compileRuntimeProviderEnvironment(section);
    expect(env.internalAgents).toEqual({
      selector: { provider: 'codex', model: 'r', providerOptions: { codex: { reasoningEffort: 'high' } } },
    });
  });

  it('throws on an unknown internal_agents key', () => {
    const section = {
      defaults: { profile: 'p' },
      profiles: { p: { provider: 'codex', model: 'm' } },
      targets: { internal_agents: { router: { profile: 'p' } } },
    } as unknown as RuntimeProviderSection;
    expect(() => compileRuntimeProviderEnvironment(section)).toThrow(/internal_agents/);
  });

  it('throws when internal_agents uses a pool', () => {
    const section: RuntimeProviderSection = {
      defaults: { pool: 'sol-pool' },
      profiles: { p: { provider: 'codex', model: 'm' }, router: { provider: 'codex', model: 'r' } },
      targets: { internal_agents: { selector: { pool: 'sol-pool' } } },
      auto_routing: {
        router_profile: 'router',
        pools: { 'sol-pool': { candidates: [{ profile: 'p', tier: 'low' }], fallback_profile: 'p' } },
      },
    };
    expect(() => compileRuntimeProviderEnvironment(section)).toThrow(/internal_agents.*pool/);
  });
});

describe('compileRuntimeProviderEnvironment fail-fast on structural inconsistencies', () => {
  it('propagates unknown-reference validation from the runtime policy', () => {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'missing' },
      profiles: { p: { provider: 'codex', model: 'm' } },
    };
    expect(() => compileRuntimeProviderEnvironment(section)).toThrow(/Unknown profile/);
  });
});

describe('collectLegacyProviderSignals', () => {
  it('reports config.yaml provider/model, provider_routing, persona_providers, auto_routing', () => {
    const signals = collectLegacyProviderSignals(
      {
        provider: 'codex',
        providerSource: 'global',
        model: 'm',
        modelSource: 'project',
        personaProviders: { coder: { provider: 'claude' } },
        providerRouting: { steps: { 'wf/impl': { provider: 'opencode' } } },
        autoRouting: {
          strategy: 'balanced',
          router: { provider: 'codex', model: 'r' },
          candidates: [],
          defaultPool: 'p',
          candidatePools: {},
        },
        providerOptions: undefined,
      },
      { name: 'wf' },
      'global',
    );
    const settings = signals.map((s) => s.setting);
    expect(settings).toContain('provider');
    expect(settings).toContain('model');
    expect(settings).toContain('persona_providers');
    expect(settings).toContain('provider_routing');
    expect(settings).toContain('auto_routing');
    for (const signal of signals) {
      expect(signal.migrateTo.length).toBeGreaterThan(0);
    }
  });

  it('does not report CLI/env overrides or unset config as legacy settings', () => {
    const signals = collectLegacyProviderSignals(
      {
        provider: 'codex',
        providerSource: 'cli',
        model: 'm',
        modelSource: 'default',
        personaProviders: undefined,
        providerRouting: undefined,
        autoRouting: undefined,
        providerOptions: undefined,
      },
      { name: 'wf' },
      'default',
    );
    expect(signals).toEqual([]);
  });

  it('does not report built-in default or env-sourced provider_options as legacy settings', () => {
    const legacy = {
      provider: undefined,
      providerSource: 'default' as const,
      model: undefined,
      modelSource: 'default' as const,
      personaProviders: undefined,
      providerRouting: undefined,
      autoRouting: undefined,
      providerOptions: { codex: { skills: { repo: false } } },
    };
    expect(collectLegacyProviderSignals(legacy, { name: 'wf' }, 'default')).toEqual([]);
    expect(collectLegacyProviderSignals(legacy, { name: 'wf' }, 'env')).toEqual([]);
  });

  it('reports provider_options only when explicitly configured in project/global config.yaml', () => {
    const legacy = {
      provider: undefined,
      providerSource: 'default' as const,
      model: undefined,
      modelSource: 'default' as const,
      personaProviders: undefined,
      providerRouting: undefined,
      autoRouting: undefined,
      providerOptions: { codex: { network_access: true } },
    };
    expect(collectLegacyProviderSignals(legacy, { name: 'wf' }, 'global').map((s) => s.setting))
      .toContain('provider_options');
    expect(collectLegacyProviderSignals(legacy, { name: 'wf' }, 'project').map((s) => s.setting))
      .toContain('provider_options');
  });

  it('reports workflow-level provider/model as legacy settings', () => {
    const signals = collectLegacyProviderSignals(
      {
        provider: 'codex',
        providerSource: 'workflow',
        model: 'm',
        modelSource: 'workflow',
        personaProviders: undefined,
        providerRouting: undefined,
        autoRouting: undefined,
        providerOptions: undefined,
      },
      { name: 'wf', provider: 'codex', model: 'm' },
      'default',
    );
    expect(signals.map((s) => s.location).some((l) => l.includes('workflow'))).toBe(true);
  });

  it('locates workflow-derived auto_routing at the workflow, not config.yaml', () => {
    const autoRouting = { strategy: 'balanced' } as unknown as LegacyProviderEnvironmentInput['autoRouting'];
    const signals = collectLegacyProviderSignals(
      {
        provider: undefined,
        providerSource: 'default',
        model: undefined,
        modelSource: 'default',
        personaProviders: undefined,
        providerRouting: undefined,
        autoRouting,
        providerOptions: undefined,
      },
      { name: 'wf', autoRouting },
      'default',
    );
    const autoRoutingSignal = signals.find((s) => s.setting === 'auto_routing');
    expect(autoRoutingSignal?.location).toBe('workflow "wf":auto_routing');
    expect(autoRoutingSignal?.location).not.toContain('config.yaml');
  });

  it('locates config.yaml-derived auto_routing at config.yaml when the workflow does not set it', () => {
    const autoRouting = { strategy: 'balanced' } as unknown as LegacyProviderEnvironmentInput['autoRouting'];
    const signals = collectLegacyProviderSignals(
      {
        provider: undefined,
        providerSource: 'default',
        model: undefined,
        modelSource: 'default',
        personaProviders: undefined,
        providerRouting: undefined,
        autoRouting,
        providerOptions: undefined,
      },
      { name: 'wf' },
      'default',
    );
    const autoRoutingSignal = signals.find((s) => s.setting === 'auto_routing');
    expect(autoRoutingSignal?.location).toBe('config.yaml:auto_routing');
  });

  it('reports takt_providers only when a selector/assistant provider is configured', () => {
    const base: LegacyProviderEnvironmentInput = {
      provider: undefined,
      providerSource: 'default',
      model: undefined,
      modelSource: 'default',
      personaProviders: undefined,
      providerRouting: undefined,
      autoRouting: undefined,
      providerOptions: undefined,
    };
    // Selector provider set → signal with the internal_agents migration target.
    const selectorSignals = collectLegacyProviderSignals(
      { ...base, taktProviders: { selector: { provider: 'opencode' } } },
      { name: 'wf' },
      'default',
    );
    const selectorSignal = selectorSignals.find((s) => s.setting === 'takt_providers');
    expect(selectorSignal).toEqual({
      setting: 'takt_providers',
      location: 'config.yaml:takt_providers',
      migrateTo: 'provider.targets.internal_agents',
    });
    // Assistant provider set → same signal.
    expect(
      collectLegacyProviderSignals(
        { ...base, taktProviders: { assistant: { provider: 'claude' } } },
        { name: 'wf' },
        'default',
      ).map((s) => s.setting),
    ).toContain('takt_providers');
    // A model-only takt_providers entry (no provider) is not a signal.
    expect(
      collectLegacyProviderSignals(
        { ...base, taktProviders: { selector: { model: 'gpt-x' } } },
        { name: 'wf' },
        'default',
      ),
    ).toEqual([]);
    // No takt_providers at all → no signal.
    expect(collectLegacyProviderSignals(base, { name: 'wf' }, 'default')).toEqual([]);
  });
});
