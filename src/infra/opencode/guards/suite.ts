import type { OpenCodeGuardOptions, OpenCodeGuardProfile } from '../../../core/models/index.js';
import {
  createBoundedSensitiveValues,
  type BoundedSensitiveValues,
} from '../../../shared/utils/sensitiveText.js';
import type { OpenCodeStreamEvent } from '../OpenCodeStreamHandler.js';
import type { ToolGuardRecoverableFailure, ToolHealthStats } from '../tool-guard.js';
import { resolveOpenCodeGuardProfile } from './profile.js';
import { OPENCODE_GUARD_REGISTRY } from './registry.js';
import { getOpenCodeGuardStrategy } from './strategy.js';
import { ToolHealthTracker, ToolOutcomeLedger } from './tool-outcome-ledger.js';
import { resolveOpenCodeGuardPolicy, type ResolvedOpenCodeGuardPolicy } from './policy.js';
import type {
  OpenCodeGuard,
  OpenCodeGuardContext,
  OpenCodeGuardDescriptor,
  OpenCodeGuardLifecycleScope,
  OpenCodeGuardVerdict,
  ToolOutcomeTuple,
} from './types.js';

interface RecoverableGuard extends OpenCodeGuard {
  takeRecoveryFailure(): ToolGuardRecoverableFailure | undefined;
}

export interface OpenCodeGuardEvaluation {
  guardId: string;
  verdict: OpenCodeGuardVerdict;
  recoveryFailure?: ToolGuardRecoverableFailure;
}

export interface OpenCodeGuardSuiteResult {
  failure?: OpenCodeGuardEvaluation;
  anomalies: readonly OpenCodeGuardEvaluation[];
}

function isRecoverableGuard(guard: OpenCodeGuard): guard is RecoverableGuard {
  return 'takeRecoveryFailure' in guard
    && typeof (guard as { takeRecoveryFailure?: unknown }).takeRecoveryFailure === 'function';
}

export class OpenCodeGuardSuite {
  readonly profile: OpenCodeGuardProfile;
  readonly policy: ResolvedOpenCodeGuardPolicy;
  readonly enabledGuardIds: readonly string[];
  readonly sensitiveValues: BoundedSensitiveValues;
  private readonly guards: readonly OpenCodeGuard[];
  private readonly toolOutcomes = new ToolOutcomeLedger();
  private readonly health = new ToolHealthTracker();
  private callFailure: OpenCodeGuardEvaluation | undefined;

  constructor(
    policy: ResolvedOpenCodeGuardPolicy,
    guards: readonly OpenCodeGuard[],
    context: OpenCodeGuardContext,
  ) {
    this.profile = policy.profile;
    this.policy = policy;
    this.guards = guards;
    this.enabledGuardIds = Object.freeze(guards.map((guard) => guard.id));
    this.sensitiveValues = context.sensitiveValues;
  }

  onInitialSource(source: unknown): OpenCodeGuardSuiteResult {
    const evaluations: OpenCodeGuardEvaluation[] = [];
    for (const guard of this.guards) {
      const verdict = guard.onInitialSource?.(source);
      if (verdict !== undefined) evaluations.push(this.evaluation(guard, verdict));
    }
    return this.partition(evaluations);
  }

  onEvent(event: OpenCodeStreamEvent): OpenCodeGuardSuiteResult {
    const terminal = this.toolOutcomes.observe(event);
    if (terminal.anomalyReason !== undefined) {
      return {
        anomalies: [{
          guardId: 'tool-protocol',
          verdict: { action: 'anomaly_log', reason: terminal.anomalyReason },
        }],
      };
    }
    if (terminal.duplicate) return { anomalies: [] };

    const evaluations = this.dispatchEvent(event);
    if (terminal.outcome !== undefined) {
      this.health.observe(terminal.outcome);
      evaluations.push(...this.dispatchToolOutcome(terminal.outcome));
    }
    const messageId = this.completedAssistantMessageId(event);
    if (messageId !== undefined) evaluations.push(...this.dispatchMessageCycle(messageId));
    return this.partition(evaluations);
  }

  startCall(onFailure: (evaluation: OpenCodeGuardEvaluation) => void): void {
    this.start('call', (evaluation) => {
      this.callFailure ??= evaluation;
      onFailure(evaluation);
    });
  }

  stopCall(): void {
    this.stop('call');
  }

  startAttempt(onFailure: (evaluation: OpenCodeGuardEvaluation) => void): void {
    this.start('attempt', onFailure);
  }

  stopAttempt(): void {
    this.stop('attempt');
  }

  getCallFailure(): OpenCodeGuardEvaluation | undefined {
    return this.callFailure;
  }

  noteRecovery(): void {
    this.health.noteRecovery();
  }

  stats(): ToolHealthStats {
    return this.health.stats();
  }

  private start(
    scope: OpenCodeGuardLifecycleScope,
    onFailure: (evaluation: OpenCodeGuardEvaluation) => void,
  ): void {
    for (const guard of this.guards) {
      guard.start?.(scope, (verdict) => onFailure(this.evaluation(guard, verdict)));
    }
  }

  private stop(scope: OpenCodeGuardLifecycleScope): void {
    for (const guard of this.guards) guard.stop?.(scope);
  }

  private dispatchEvent(event: OpenCodeStreamEvent): OpenCodeGuardEvaluation[] {
    const evaluations: OpenCodeGuardEvaluation[] = [];
    for (const guard of this.guards) {
      const verdict = guard.onEvent?.(event);
      if (verdict !== undefined) evaluations.push(this.evaluation(guard, verdict));
    }
    return evaluations;
  }

  private dispatchToolOutcome(outcome: ToolOutcomeTuple): OpenCodeGuardEvaluation[] {
    const evaluations: OpenCodeGuardEvaluation[] = [];
    for (const guard of this.guards) {
      const verdict = guard.onToolOutcome?.(outcome);
      if (verdict !== undefined) evaluations.push(this.evaluation(guard, verdict));
    }
    return evaluations;
  }

  private dispatchMessageCycle(messageId: string): OpenCodeGuardEvaluation[] {
    const evaluations: OpenCodeGuardEvaluation[] = [];
    for (const guard of this.guards) {
      const verdict = guard.onMessageCycle?.(messageId);
      if (verdict !== undefined) evaluations.push(this.evaluation(guard, verdict));
    }
    return evaluations;
  }

  private evaluation(guard: OpenCodeGuard, verdict: OpenCodeGuardVerdict): OpenCodeGuardEvaluation {
    const recoveryFailure = isRecoverableGuard(guard) ? guard.takeRecoveryFailure() : undefined;
    return {
      guardId: guard.id,
      verdict,
      ...(recoveryFailure !== undefined ? { recoveryFailure } : {}),
    };
  }

  private partition(evaluations: readonly OpenCodeGuardEvaluation[]): OpenCodeGuardSuiteResult {
    return {
      failure: evaluations.find((evaluation) => evaluation.verdict.action === 'fail'),
      anomalies: evaluations.filter((evaluation) => evaluation.verdict.action === 'anomaly_log'),
    };
  }

  private completedAssistantMessageId(event: OpenCodeStreamEvent): string | undefined {
    if (event.type !== 'message.updated' && event.type !== 'message.completed') return undefined;
    const info = event.properties.info as Record<string, unknown> | undefined;
    if (info?.role !== 'assistant' || typeof info.sessionID !== 'string') return undefined;
    if (event.type === 'message.updated') {
      const time = info.time as { completed?: unknown } | undefined;
      if (time?.completed === undefined) return undefined;
    }
    const id = typeof info.id === 'string'
      ? info.id
      : typeof info.messageID === 'string'
        ? info.messageID
        : undefined;
    return id === undefined ? undefined : `${info.sessionID}\0${id}`;
  }
}

export function resolveOpenCodeGuardSuite(
  guards: OpenCodeGuardOptions | undefined,
  model: string,
  registry: readonly OpenCodeGuardDescriptor[] = OPENCODE_GUARD_REGISTRY,
): OpenCodeGuardSuite {
  const profile = resolveOpenCodeGuardProfile(guards, model);
  const policy = resolveOpenCodeGuardPolicy(guards, profile);
  const descriptors = getOpenCodeGuardStrategy(profile).selectGuards(registry);
  const mandatoryDescriptors = OPENCODE_GUARD_REGISTRY.filter((descriptor) => descriptor.mandatory);
  if (mandatoryDescriptors.some((descriptor) => !descriptors.includes(descriptor))) {
    throw new Error(`OpenCode guard profile "${profile}" attempted to remove a mandatory guard`);
  }
  const context: OpenCodeGuardContext = {
    sensitiveValues: createBoundedSensitiveValues(),
  };
  return new OpenCodeGuardSuite(
    policy,
    descriptors.map((descriptor) => descriptor.create(policy, context)),
    context,
  );
}
