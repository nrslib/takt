import type { AutoRoutingCandidate, AutoRoutingConfig, RoutingTier } from '../../models/config-types.js';
import type { WorkRequirementEstimate } from './contracts.js';
import { resolveWorkflowStepTarget } from '../provider-target-resolution.js';

const TIER_ORDER: Record<RoutingTier, number> = { low: 0, medium: 1, high: 2 };

export interface RoutingSelectionInput {
  autoRouting: AutoRoutingConfig;
  step: { name: string; tags?: string[]; personaKey?: string };
  estimate?: WorkRequirementEstimate;
  estimatorFailure?: Error;
}

export interface RoutingSelection {
  candidate: AutoRoutingCandidate;
  poolName?: string;
  resolutionSource: 'auto.rules' | 'auto.dynamic' | 'auto.fallback';
  requiredTier?: RoutingTier;
  fallbackReason?: 'estimator-failure';
}

export type ExecutableRoutingCandidates =
  | {
    candidates: [AutoRoutingCandidate];
    selectionCandidates: [AutoRoutingCandidate];
    resolutionSource: 'auto.rules';
  }
  | {
    candidates: AutoRoutingCandidate[];
    selectionCandidates: AutoRoutingCandidate[];
    fallbackCandidate: AutoRoutingCandidate;
    poolName: string;
    resolutionSource: 'auto.dynamic';
  };

type RoutingPoolTarget = { name?: string; tags?: string[]; personaKey?: string };

function findCandidate(config: AutoRoutingConfig, candidateName: string | undefined): AutoRoutingCandidate | undefined {
  return candidateName === undefined ? undefined : config.candidates.find((candidate) => candidate.name === candidateName);
}

function findMappingValue(mapping: Record<string, string> | undefined, key: string | undefined): string | undefined {
  return key !== undefined && mapping !== undefined && Object.hasOwn(mapping, key) ? mapping[key] : undefined;
}

function matchRule(config: AutoRoutingConfig, step: RoutingSelectionInput['step']): AutoRoutingCandidate['name'] | undefined {
  const rules = config.rules;
  let matchedCandidate: AutoRoutingCandidate['name'] | undefined;
  for (const tag of step.tags ?? []) {
    const candidate = findMappingValue(rules?.tags, tag);
    if (candidate !== undefined) matchedCandidate = candidate;
  }
  return matchedCandidate
    ?? resolveWorkflowStepTarget(rules?.steps, step.name, config.workflowName)
    ?? findMappingValue(rules?.personas, step.personaKey);
}

export function resolveAutoRoutingRuleCandidate(
  autoRouting: AutoRoutingConfig,
  step: RoutingSelectionInput['step'],
): AutoRoutingCandidate | undefined {
  return findCandidate(autoRouting, matchRule(autoRouting, step));
}

function resolveExplicitPoolName(
  config: AutoRoutingConfig,
  step: RoutingPoolTarget,
): string | undefined {
  let matchedPool: string | undefined;
  for (const tag of step.tags ?? []) {
    const poolName = findMappingValue(config.poolRules?.tags, tag);
    if (poolName !== undefined) matchedPool = poolName;
  }
  return matchedPool
    ?? resolveWorkflowStepTarget(config.poolRules?.steps, step.name, config.workflowName)
    ?? findMappingValue(config.poolRules?.personas, step.personaKey);
}

export function hasAutoRoutingPoolAssignment(
  config: AutoRoutingConfig,
  step: RoutingPoolTarget,
): boolean {
  return resolveExplicitPoolName(config, step) !== undefined;
}

function resolvePoolName(config: AutoRoutingConfig, step: RoutingSelectionInput['step']): string {
  const poolName = resolveExplicitPoolName(config, step) ?? config.defaultPool;
  if (poolName === undefined) {
    throw new Error(`Auto routing has no pool assignment for step "${step.name}"`);
  }
  return poolName;
}

function resolveCandidate(config: AutoRoutingConfig, poolName: string, candidateName: string, reference: 'candidate' | 'fallback'): AutoRoutingCandidate {
  const candidate = findCandidate(config, candidateName);
  if (candidate === undefined) {
    throw new Error(
      reference === 'candidate'
        ? `Auto routing pool "${poolName}" references unknown candidate "${candidateName}"`
        : `Auto routing pool "${poolName}" fallback is unknown`,
    );
  }
  return candidate;
}

export function resolveExecutableRoutingCandidates(
  autoRouting: AutoRoutingConfig,
  step: RoutingSelectionInput['step'],
): ExecutableRoutingCandidates {
  const hardRule = resolveAutoRoutingRuleCandidate(autoRouting, step);
  if (hardRule !== undefined) {
    return {
      candidates: [hardRule],
      selectionCandidates: [hardRule],
      resolutionSource: 'auto.rules',
    };
  }

  const poolName = resolvePoolName(autoRouting, step);
  const pool = Object.hasOwn(autoRouting.candidatePools, poolName)
    ? autoRouting.candidatePools[poolName]
    : undefined;
  if (pool === undefined) throw new Error(`Auto routing pool "${poolName}" is not configured`);

  const selectionCandidates = pool.candidates.map((candidateName) =>
    resolveCandidate(autoRouting, poolName, candidateName, 'candidate'));
  const fallbackCandidate = resolveCandidate(autoRouting, poolName, pool.fallback, 'fallback');
  const candidates = selectionCandidates.some((candidate) => candidate.name === fallbackCandidate.name)
    ? selectionCandidates
    : [...selectionCandidates, fallbackCandidate];
  return {
    candidates,
    selectionCandidates,
    fallbackCandidate,
    poolName,
    resolutionSource: 'auto.dynamic',
  };
}

function chooseCandidate(candidates: AutoRoutingCandidate[], tier: RoutingTier, strategy: AutoRoutingConfig['strategy']): AutoRoutingCandidate {
  const eligible = candidates.filter((candidate) => TIER_ORDER[candidate.routingTier] >= TIER_ORDER[tier]);
  if (eligible.length === 0) {
    throw new Error(`No eligible candidate meets required ${tier} routing tier`);
  }
  if (strategy === 'performance') {
    return eligible.reduce((selected, candidate) => TIER_ORDER[candidate.routingTier] > TIER_ORDER[selected.routingTier] ? candidate : selected);
  }
  return eligible.reduce((selected, candidate) => TIER_ORDER[candidate.routingTier] < TIER_ORDER[selected.routingTier] ? candidate : selected);
}

export function selectRoutingCandidate(input: RoutingSelectionInput): RoutingSelection {
  const resolved = resolveExecutableRoutingCandidates(input.autoRouting, input.step);
  if (resolved.resolutionSource === 'auto.rules') {
    return { candidate: resolved.candidates[0], resolutionSource: resolved.resolutionSource };
  }
  if (input.estimatorFailure !== undefined) {
    return {
      candidate: resolved.fallbackCandidate,
      poolName: resolved.poolName,
      resolutionSource: 'auto.fallback',
      fallbackReason: 'estimator-failure',
    };
  }
  if (input.estimate === undefined) throw new Error('Auto routing requires a work requirement estimate');
  return {
    candidate: chooseCandidate(resolved.selectionCandidates, input.estimate.requiredTier, input.autoRouting.strategy),
    poolName: resolved.poolName,
    resolutionSource: 'auto.dynamic',
    requiredTier: input.estimate.requiredTier,
  };
}

export function maxRoutingTier(left: RoutingTier, right: RoutingTier): RoutingTier {
  return TIER_ORDER[left] >= TIER_ORDER[right] ? left : right;
}

export function promoteRoutingTier(tier: RoutingTier): RoutingTier {
  return tier === 'low' ? 'medium' : 'high';
}
