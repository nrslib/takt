import { ConsecutiveErrorsGuard, CycleBudgetGuard } from './heuristic-guards.js';
import { ExactLoopGuard, ExactRepeatStreakGuard } from './integrity-guards.js';
import {
  EventCountGuard,
  ReasoningVolumeGuard,
  SensitiveBudgetGuard,
  TextVolumeGuard,
  TrackedIdsGuard,
} from './resource-guards.js';
import { WallClockGuard } from './time-guards.js';
import type { OpenCodeGuardDescriptor } from './types.js';

export const OPENCODE_GUARD_REGISTRY: readonly OpenCodeGuardDescriptor[] = Object.freeze([
  { id: 'text-volume', layer: 'resource', mandatory: true, create: (policy) => new TextVolumeGuard(policy) },
  { id: 'reasoning-volume', layer: 'resource', mandatory: true, create: (policy) => new ReasoningVolumeGuard(policy) },
  { id: 'event-count', layer: 'resource', mandatory: true, create: (policy) => new EventCountGuard(policy.streamEventLimit) },
  { id: 'tracked-ids', layer: 'resource', mandatory: true, create: (policy) => new TrackedIdsGuard(policy.streamLimits.idLimit) },
  {
    id: 'sensitive-budget',
    layer: 'integrity',
    mandatory: true,
    create: (_policy, context) => new SensitiveBudgetGuard(context.sensitiveValues),
  },
  { id: 'wall-clock', layer: 'time', mandatory: true, create: (policy) => new WallClockGuard(policy.callTimeoutMs) },
  { id: 'exact-loop', layer: 'integrity', mandatory: true, create: (policy) => new ExactLoopGuard(policy) },
  { id: 'consecutive-errors', layer: 'heuristic', mandatory: false, create: (policy) => new ConsecutiveErrorsGuard(policy) },
  { id: 'cycle-budget', layer: 'heuristic', mandatory: false, create: (policy) => new CycleBudgetGuard(policy.messageCycleBudget) },
  { id: 'exact-repeat-streak', layer: 'heuristic', mandatory: false, create: (policy) => new ExactRepeatStreakGuard(policy.exactToolRepeatLimit) },
]);
