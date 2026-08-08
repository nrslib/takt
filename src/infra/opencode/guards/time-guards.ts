import type { OpenCodeStreamEvent } from '../OpenCodeStreamHandler.js';
import {
  isOpenCodeToolTerminal,
  openCodeToolCallKey,
  readOpenCodeToolPart,
} from './tool-events.js';
import type { OpenCodeGuard, OpenCodeGuardLifecycleScope, OpenCodeGuardVerdict } from './types.js';

export function describeOpenCodeIdleTimeout(timeoutMs: number): string {
  return `OpenCode stream timed out after ${Math.round(timeoutMs / 60000)} minutes of inactivity`;
}

export class WallClockGuard implements OpenCodeGuard {
  readonly id = 'wall-clock';
  readonly layer = 'time' as const;
  private timeoutId: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly timeoutMs: number) {}

  start(scope: OpenCodeGuardLifecycleScope, onVerdict: (verdict: OpenCodeGuardVerdict) => void): void {
    if (scope !== 'call') return;
    this.stop('call');
    const timeoutId = setTimeout(() => {
      onVerdict({
        action: 'fail',
        reason: `OpenCode call wall-clock timeout exceeded (${this.timeoutMs} ms)`,
        abortKind: 'deadline',
      });
    }, this.timeoutMs);
    timeoutId.unref();
    this.timeoutId = timeoutId;
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
  private readonly inFlightToolCalls = new Set<string>();

  constructor(private readonly timeoutMs: number) {}

  start(scope: OpenCodeGuardLifecycleScope, onVerdict: (verdict: OpenCodeGuardVerdict) => void): void {
    if (scope !== 'attempt') return;
    this.inFlightToolCalls.clear();
    this.onVerdict = onVerdict;
    this.arm();
  }

  onEvent(event: OpenCodeStreamEvent): OpenCodeGuardVerdict | undefined {
    this.trackToolFlight(event);
    this.arm();
    return undefined;
  }

  stop(scope: OpenCodeGuardLifecycleScope): void {
    if (scope !== 'attempt') return;
    this.disarm();
    this.inFlightToolCalls.clear();
    this.onVerdict = undefined;
  }

  private trackToolFlight(event: OpenCodeStreamEvent): void {
    const toolPart = readOpenCodeToolPart(event);
    if (toolPart === undefined) return;
    const key = openCodeToolCallKey(toolPart);
    if (isOpenCodeToolTerminal(toolPart)) {
      this.inFlightToolCalls.delete(key);
      return;
    }
    this.inFlightToolCalls.add(key);
  }

  private arm(): void {
    if (this.onVerdict === undefined) return;
    this.disarm();
    // テストスイート実行のような長時間のツール呼び出しの間、OpenCode は
    // tool_use から tool_result までイベントを1つも流さない。この無音を
    // アイドルと判定すると健全な実行を切ってしまうため、in-flight のツール
    // 呼び出しが1つでもある間は計測しない。結果が返らないツールは call scope の
    // wall-clock guard が受け持つ。
    if (this.inFlightToolCalls.size > 0) return;
    this.timeoutId = setTimeout(() => {
      this.onVerdict?.({
        action: 'fail',
        reason: describeOpenCodeIdleTimeout(this.timeoutMs),
      });
    }, this.timeoutMs);
  }

  private disarm(): void {
    if (this.timeoutId === undefined) return;
    clearTimeout(this.timeoutId);
    this.timeoutId = undefined;
  }
}
