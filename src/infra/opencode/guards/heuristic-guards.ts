import type {
  ToolGuardRecoverableFailure,
  ToolHealthStats,
} from '../tool-guard.js';
import type { ResolvedOpenCodeGuardPolicy } from './policy.js';
import type {
  OpenCodeGuard,
  OpenCodeGuardLifecycleScope,
  OpenCodeGuardVerdict,
  ToolOutcomeTuple,
} from './types.js';

export class ConsecutiveErrorsGuard implements OpenCodeGuard {
  readonly id = 'consecutive-errors';
  readonly layer = 'heuristic' as const;
  private consecutiveErrors = 0;
  private maxConsecutiveErrors = 0;
  private totalErrors = 0;
  private totalSuccesses = 0;
  private toolEventsSinceLastProgress = 0;
  private recentWindow: boolean[] = [];
  private recoveryFailure: ToolGuardRecoverableFailure | undefined;

  constructor(private readonly policy: ResolvedOpenCodeGuardPolicy) {}

  start(scope: OpenCodeGuardLifecycleScope): void {
    if (scope !== 'attempt') return;
    this.consecutiveErrors = 0;
    this.toolEventsSinceLastProgress = 0;
    this.recentWindow = [];
  }

  onToolOutcome(outcome: ToolOutcomeTuple): OpenCodeGuardVerdict | undefined {
    if (outcome.outcome === 'success') {
      this.totalSuccesses += 1;
      this.consecutiveErrors = 0;
      this.toolEventsSinceLastProgress = 0;
      this.pushWindow(false);
      return undefined;
    }
    this.totalErrors += 1;
    this.consecutiveErrors += 1;
    this.maxConsecutiveErrors = Math.max(this.maxConsecutiveErrors, this.consecutiveErrors);
    this.toolEventsSinceLastProgress += 1;
    this.pushWindow(true);
    const stats = this.stats(0);
    const windowExceeded = this.recentWindow.length >= this.policy.toolGuard.recentWindow
      && stats.recentErrorRate * 100 >= this.policy.toolGuard.recentWindowErrorRatePercent;
    if (this.consecutiveErrors < this.policy.toolGuard.consecutiveErrors && !windowExceeded) {
      return undefined;
    }
    const failure: ToolGuardRecoverableFailure = {
      kind: 'tool_error_burst',
      fingerprint: 'tool_error_burst',
      stats,
      message: `OpenCode tool error burst detected (${this.consecutiveErrors} consecutive errors without progress, recent error rate ${(stats.recentErrorRate * 100).toFixed(0)}% over ${stats.recentWindowSize} events; last tool "${outcome.tool}")`,
    };
    this.recoveryFailure = failure;
    return { action: 'fail', reason: failure.message };
  }

  takeRecoveryFailure(): ToolGuardRecoverableFailure | undefined {
    const failure = this.recoveryFailure;
    this.recoveryFailure = undefined;
    return failure;
  }

  stats(recoveriesUsed: number): ToolHealthStats {
    const windowErrors = this.recentWindow.filter(Boolean).length;
    return {
      totalErrors: this.totalErrors,
      totalSuccesses: this.totalSuccesses,
      maxConsecutiveErrors: this.maxConsecutiveErrors,
      recentErrorRate: this.recentWindow.length === 0 ? 0 : windowErrors / this.recentWindow.length,
      recentWindowSize: this.recentWindow.length,
      maxSameSignatureRepeats: 0,
      toolEventsSinceLastProgress: this.toolEventsSinceLastProgress,
      recoveriesUsed,
    };
  }

  private pushWindow(isError: boolean): void {
    this.recentWindow.push(isError);
    while (this.recentWindow.length > this.policy.toolGuard.recentWindow) {
      this.recentWindow.shift();
    }
  }
}

export class CycleBudgetGuard implements OpenCodeGuard {
  readonly id = 'cycle-budget';
  readonly layer = 'heuristic' as const;
  private readonly completedMessages = new Set<string>();
  private cyclesWithoutToolSuccess = 0;

  constructor(private readonly limit: number) {}

  start(scope: OpenCodeGuardLifecycleScope): void {
    if (scope !== 'attempt') return;
    this.completedMessages.clear();
    this.cyclesWithoutToolSuccess = 0;
  }

  onToolOutcome(outcome: ToolOutcomeTuple): OpenCodeGuardVerdict | undefined {
    if (outcome.outcome === 'success') this.cyclesWithoutToolSuccess = 0;
    return undefined;
  }

  onMessageCycle(messageId: string): OpenCodeGuardVerdict | undefined {
    if (this.completedMessages.has(messageId)) return undefined;
    this.completedMessages.add(messageId);
    this.cyclesWithoutToolSuccess += 1;
    if (this.cyclesWithoutToolSuccess < this.limit) return undefined;
    return {
      action: 'fail',
      reason: `OpenCode assistant message cycle budget exceeded (${this.cyclesWithoutToolSuccess} cycles without a successful tool call)`,
    };
  }
}
