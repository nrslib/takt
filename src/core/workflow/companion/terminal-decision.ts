export interface CompanionLoopDecision {
  readonly decision: 'continue' | 'escalate';
  readonly reason?: string;
}

export class CompanionTerminalDecisionTracker {
  private current: CompanionLoopDecision = { decision: 'continue' };

  update(next: CompanionLoopDecision): void {
    if (this.current.decision === 'escalate') return;
    this.current = cloneDecision(next);
  }

  preserveUnreviewedCompletionAfterFailure(): void {
    if (this.current.decision === 'escalate') return;
    this.current = {
      decision: 'escalate',
      reason: 'Companion completion review could not verify all pending changes.',
    };
  }

  get(): CompanionLoopDecision {
    return cloneDecision(this.current);
  }

  reset(): void {
    this.current = { decision: 'continue' };
  }
}

function cloneDecision(decision: CompanionLoopDecision): CompanionLoopDecision {
  return {
    decision: decision.decision,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
  };
}
