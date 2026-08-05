import type { OpenCodeGuardProfile } from '../../../core/models/index.js';
import type { OpenCodeGuardDescriptor, OpenCodeGuardStrategy } from './types.js';

export class StandardOpenCodeGuardStrategy implements OpenCodeGuardStrategy {
  readonly profile = 'standard' as const;

  selectGuards(registry: readonly OpenCodeGuardDescriptor[]): readonly OpenCodeGuardDescriptor[] {
    return registry;
  }
}

export class MinimalOpenCodeGuardStrategy implements OpenCodeGuardStrategy {
  readonly profile = 'minimal' as const;

  selectGuards(registry: readonly OpenCodeGuardDescriptor[]): readonly OpenCodeGuardDescriptor[] {
    return registry.filter((descriptor) => descriptor.mandatory);
  }
}

const STRATEGIES: Readonly<Record<OpenCodeGuardProfile, OpenCodeGuardStrategy>> = Object.freeze({
  standard: new StandardOpenCodeGuardStrategy(),
  minimal: new MinimalOpenCodeGuardStrategy(),
});

export function getOpenCodeGuardStrategy(profile: OpenCodeGuardProfile): OpenCodeGuardStrategy {
  const strategy = (STRATEGIES as Readonly<Record<string, OpenCodeGuardStrategy | undefined>>)[profile];
  if (!strategy) {
    throw new Error(`Unknown OpenCode guard profile: ${String(profile)}`);
  }
  return strategy;
}
