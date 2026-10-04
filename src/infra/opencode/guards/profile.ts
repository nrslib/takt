import type { OpenCodeGuardOptions, OpenCodeGuardProfile } from '../../../core/models/index.js';

function wildcardMatches(pattern: string, model: string): boolean {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(model);
}

export function resolveOpenCodeGuardProfile(
  guards: OpenCodeGuardOptions | undefined,
  model: string,
): OpenCodeGuardProfile {
  for (const [pattern, profile] of Object.entries(guards?.modelProfiles ?? {})) {
    if (wildcardMatches(pattern, model)) return profile;
  }
  return guards?.profile ?? 'standard';
}
