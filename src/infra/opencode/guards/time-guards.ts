import type { OpenCodeStreamEvent } from '../OpenCodeStreamHandler.js';
import type { OpenCodeGuard, OpenCodeGuardLifecycleScope, OpenCodeGuardVerdict } from './types.js';

export class WallClockGuard implements OpenCodeGuard {
  readonly id = 'wall-clock';
  readonly layer = 'time' as const;
  private timeoutId: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly timeoutMs: number) {}

  start(scope: OpenCodeGuardLifecycleScope, onVerdict: (verdict: OpenCodeGuardVerdict) => void): void {
    if (scope !== 'call') return;
    this.stop('call');
    this.timeoutId = setTimeout(() => {
      onVerdict({
        action: 'fail',
        reason: `OpenCode call wall-clock timeout exceeded (${this.timeoutMs} ms)`,
        abortKind: 'deadline',
      });
    }, this.timeoutMs);
  }

  stop(scope: OpenCodeGuardLifecycleScope): void {
    if (scope !== 'call' || this.timeoutId === undefined) return;
    clearTimeout(this.timeoutId);
    this.timeoutId = undefined;
  }
}

export class IdleTimeoutGuard implements OpenCodeGuard {
  readonly id = 'idle-timeout';
  readonly layer = 'time' as const;
  private timeoutId: ReturnType<typeof setTimeout> | undefined;
  private onVerdict: ((verdict: OpenCodeGuardVerdict) => void) | undefined;

  constructor(private readonly timeoutMs: number) {}

  start(scope: OpenCodeGuardLifecycleScope, onVerdict: (verdict: OpenCodeGuardVerdict) => void): void {
    if (scope !== 'attempt') return;
    this.onVerdict = onVerdict;
    this.arm();
  }

  onEvent(_event: OpenCodeStreamEvent): OpenCodeGuardVerdict | undefined {
    this.arm();
    return undefined;
  }

  stop(scope: OpenCodeGuardLifecycleScope): void {
    if (scope !== 'attempt') return;
    if (this.timeoutId !== undefined) clearTimeout(this.timeoutId);
    this.timeoutId = undefined;
    this.onVerdict = undefined;
  }

  private arm(): void {
    if (this.onVerdict === undefined) return;
    if (this.timeoutId !== undefined) clearTimeout(this.timeoutId);
    this.timeoutId = setTimeout(() => {
      this.onVerdict?.({
        action: 'fail',
        reason: `OpenCode stream timed out after ${Math.round(this.timeoutMs / 60000)} minutes of inactivity`,
      });
    }, this.timeoutMs);
  }
}
