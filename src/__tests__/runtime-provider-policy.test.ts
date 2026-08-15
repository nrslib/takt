import { describe, expect, it } from 'vitest';
import {
  validateRuntimeProviderSection,
  flattenProfiles,
} from '../infra/config/runtime-provider/policy.js';
import type { RuntimeProviderSection } from '../infra/config/runtime-provider/schema.js';

/**
 * `validateRuntimeProviderSection` performs the up-front reference validation for a runtime.yaml
 * `provider` section (issue #1136): it resolves every `extends` chain and asserts that every
 * profile/pool reference exists and that referenced profiles define provider+model, failing fast
 * (before any agent runs) with no silent fallback.
 *
 * Runtime-v1 resolution itself (priority ladder + same-priority tag conflict fail-fast) is
 * compiled into the shared engine-options bundle and enforced at the per-step seam; those
 * contracts are covered by runtime-provider-environment.test.ts and provider-resolution.test.ts.
 */

function ladderSection(): RuntimeProviderSection {
  return {
    defaults: { profile: 'p-default' },
    profiles: {
      'p-default': { provider: 'mock', model: 'm-default' },
      'p-persona': { provider: 'mock', model: 'm-persona' },
      'p-tag': { provider: 'mock', model: 'm-tag' },
      'p-step': { provider: 'mock', model: 'm-step' },
      'p-internal': { provider: 'mock', model: 'm-internal' },
    },
    targets: {
      personas: { coder: { profile: 'p-persona' } },
      tags: { 'high-stakes': { profile: 'p-tag' } },
      steps: { 'leaf/implement': { profile: 'p-step' } },
      internal_agents: { selector: { profile: 'p-internal' } },
    },
  };
}

describe('validateRuntimeProviderSection — valid sections', () => {
  it('accepts a fully-populated ladder section', () => {
    expect(() => validateRuntimeProviderSection(ladderSection())).not.toThrow();
  });

  it('rejects an active section without defaults', () => {
    expect(() => validateRuntimeProviderSection({
      profiles: { real: { provider: 'mock', model: 'm' } },
    } as RuntimeProviderSection)).toThrow(/defaults/);
  });

  it('rejects defaults.pool even when the referenced pool exists', () => {
    expect(() => validateRuntimeProviderSection({
      defaults: { pool: 'pool-a' },
      profiles: {
        real: { provider: 'mock', model: 'm' },
        router: { provider: 'mock', model: 'router' },
      },
      auto_routing: {
        router_profile: 'router',
        pools: {
          'pool-a': {
            candidates: [{ profile: 'real', tier: 'low' }],
            fallback_profile: 'real',
          },
        },
      },
    } as unknown as RuntimeProviderSection)).toThrow(/defaults.*pool|pool.*defaults/);
  });

  it('rejects defaults.pool when auto_routing is absent', () => {
    expect(() => validateRuntimeProviderSection({
      defaults: { pool: 'pool-a' },
      profiles: { real: { provider: 'mock', model: 'model-real' } },
    } as unknown as RuntimeProviderSection)).toThrow(/defaults.*pool|pool.*defaults/);
  });
});

describe('validateRuntimeProviderSection — extends (C3/C10)', () => {
  it('accepts a profile that extends another', () => {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'child' },
      profiles: {
        base: { provider: 'codex', model: 'gpt', options: { reasoning_effort: 'high' } },
        child: { extends: 'base', options: { reasoning_effort: 'low' } },
      },
    };
    expect(() => validateRuntimeProviderSection(section)).not.toThrow();
  });

  it('fails fast on a cyclic extends chain', () => {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'a' },
      profiles: {
        a: { extends: 'b', provider: 'mock' },
        b: { extends: 'a', provider: 'mock' },
      },
    };
    expect(() => validateRuntimeProviderSection(section)).toThrow(/cyclic/i);
  });

  it('fails fast on an extends pointing at an unknown profile', () => {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'a' },
      profiles: { a: { extends: 'ghost', provider: 'mock' } },
    };
    expect(() => validateRuntimeProviderSection(section)).toThrow(/ghost|unknown profile/i);
  });
});

describe('validateRuntimeProviderSection — unknown reference fail-fast (C10)', () => {
  it('fails fast on a defaults.profile that is not defined', () => {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'ghost' },
      profiles: { real: { provider: 'mock', model: 'm' } },
    };
    expect(() => validateRuntimeProviderSection(section)).toThrow(/ghost|unknown profile/i);
  });

  it('fails fast on a target that references an unknown profile', () => {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'real' },
      profiles: { real: { provider: 'mock', model: 'm' } },
      targets: { personas: { coder: { profile: 'ghost' } } },
    };
    expect(() => validateRuntimeProviderSection(section)).toThrow(/ghost|unknown profile/i);
  });

  it('fails fast on a referenced profile missing provider or model', () => {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'partial' },
      profiles: { partial: { provider: 'mock' } },
    };
    expect(() => validateRuntimeProviderSection(section)).toThrow(/provider.*model|model.*provider/i);
  });
});

describe('validateRuntimeProviderSection — auto_routing references (C9/C10)', () => {
  function autoSection(overrides: (s: RuntimeProviderSection) => void): RuntimeProviderSection {
    const section: RuntimeProviderSection = {
      defaults: { profile: 'hi' },
      profiles: {
        hi: { provider: 'codex', model: 'gpt', options: { reasoning_effort: 'high' } },
        lo: { provider: 'codex', model: 'gpt', options: { reasoning_effort: 'low' } },
        router: { provider: 'codex', model: 'gpt-router' },
      },
      auto_routing: {
        router_profile: 'router',
        pools: {
          'pool-a': {
            candidates: [{ profile: 'hi', tier: 'high' }, { profile: 'lo', tier: 'low' }],
            fallback_profile: 'hi',
          },
        },
      },
    };
    overrides(section);
    return section;
  }

  it('accepts valid profile/pool references', () => {
    expect(() => validateRuntimeProviderSection(autoSection(() => {}))).not.toThrow();
  });

  it('fails fast on an unknown router_profile', () => {
    expect(() => validateRuntimeProviderSection(autoSection((s) => {
      s.auto_routing!.router_profile = 'ghost';
    }))).toThrow(/ghost|unknown profile/i);
  });

  it('fails fast on a candidate referencing an unknown profile', () => {
    expect(() => validateRuntimeProviderSection(autoSection((s) => {
      s.auto_routing!.pools!['pool-a']!.candidates[0]!.profile = 'ghost';
    }))).toThrow(/ghost|unknown profile/i);
  });

  it('fails fast on an unknown fallback_profile', () => {
    expect(() => validateRuntimeProviderSection(autoSection((s) => {
      s.auto_routing!.pools!['pool-a']!.fallback_profile = 'ghost';
    }))).toThrow(/ghost|unknown profile/i);
  });

  it('fails fast on defaults referencing an undefined pool', () => {
    expect(() => validateRuntimeProviderSection(autoSection((s) => {
      s.targets = { steps: { execute: { pool: 'missing' } } };
    }))).toThrow(/missing|unknown pool/i);
  });
});

describe('flattenProfiles', () => {
  it('resolves inherited fields and lets own fields override', () => {
    const flat = flattenProfiles({
      base: { provider: 'codex', model: 'gpt', options: { reasoning_effort: 'high' } },
      child: { extends: 'base', options: { reasoning_effort: 'low' } },
    });
    expect(flat.get('child')).toEqual({
      provider: 'codex',
      model: 'gpt',
      options: { reasoning_effort: 'low' },
    });
  });
});
