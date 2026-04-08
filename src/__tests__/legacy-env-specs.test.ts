import { describe, expect, it } from 'vitest';
import { COMMON_LEGACY_ENV_SPECS } from '../infra/config/env/common-legacy-env-specs.js';
import { GLOBAL_LEGACY_ENV_SPECS } from '../infra/config/env/global-legacy-env-specs.js';
import { PROJECT_LEGACY_ENV_SPECS } from '../infra/config/env/project-legacy-env-specs.js';

describe('legacy env specs', () => {
  it('project legacy specs reuse the shared removed legacy env definitions', () => {
    expect(PROJECT_LEGACY_ENV_SPECS).toBe(COMMON_LEGACY_ENV_SPECS);
  });

  it('global legacy specs include the shared removed legacy env definitions exactly once', () => {
    const sharedEnvNames = new Set(COMMON_LEGACY_ENV_SPECS.map((spec) => spec.env));
    const globalSharedSpecs = GLOBAL_LEGACY_ENV_SPECS.filter((spec) => sharedEnvNames.has(spec.env));

    expect(globalSharedSpecs).toEqual(COMMON_LEGACY_ENV_SPECS);
    expect(new Set(GLOBAL_LEGACY_ENV_SPECS.map((spec) => spec.env)).size).toBe(GLOBAL_LEGACY_ENV_SPECS.length);
  });

  it('removed legacy env specs expose only the fail-fast contract fields', () => {
    for (const spec of GLOBAL_LEGACY_ENV_SPECS) {
      expect(spec).toEqual({
        env: spec.env,
        path: spec.path,
        canonicalPath: spec.canonicalPath,
      });
    }
  });
});
