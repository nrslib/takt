import type { OpenCodeGuardProfile } from '../../../core/models/index.js';
import type { BoundedSensitiveValues } from '../../../shared/utils/sensitiveText.js';
import type { OpenCodeStreamEvent } from '../OpenCodeStreamHandler.js';
import type { ResolvedOpenCodeGuardPolicy } from './policy.js';

export type OpenCodeGuardLayer = 'time' | 'resource' | 'integrity' | 'heuristic';
export type OpenCodeGuardAbortKind = 'deadline';

export interface OpenCodeGuardVerdict {
  action: 'fail' | 'anomaly_log';
  reason: string;
  abortKind?: OpenCodeGuardAbortKind;
}

export interface ToolOutcomeTuple {
  sessionId: string;
  callId: string;
  tool: string;
  outcome: 'success' | 'failure';
  inputHash: string;
  resultHash: string;
  identityKey: string;
  key: string;
}

export type OpenCodeGuardLifecycleScope = 'call' | 'attempt';

export interface OpenCodeGuardContext {
  readonly sensitiveValues: BoundedSensitiveValues;
}

export interface OpenCodeGuard {
  readonly id: string;
  readonly layer: OpenCodeGuardLayer;
  onInitialSource?(source: unknown): OpenCodeGuardVerdict | undefined;
  onEvent?(event: OpenCodeStreamEvent): OpenCodeGuardVerdict | undefined;
  onToolOutcome?(outcome: ToolOutcomeTuple): OpenCodeGuardVerdict | undefined;
  onMessageCycle?(messageId: string): OpenCodeGuardVerdict | undefined;
  start?(scope: OpenCodeGuardLifecycleScope, onVerdict: (verdict: OpenCodeGuardVerdict) => void): void;
  stop?(scope: OpenCodeGuardLifecycleScope): void;
}

export interface OpenCodeGuardDescriptor {
  readonly id: string;
  readonly layer: OpenCodeGuardLayer;
  readonly mandatory: boolean;
  create(policy: ResolvedOpenCodeGuardPolicy, context: OpenCodeGuardContext): OpenCodeGuard;
}

export interface OpenCodeGuardStrategy {
  readonly profile: OpenCodeGuardProfile;
  selectGuards(registry: readonly OpenCodeGuardDescriptor[]): readonly OpenCodeGuardDescriptor[];
}
