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

// カスタムの認証済み transport が idle watchdog を明示的に登録する場合に、
// ツール結果イベントの取りこぼしで in-flight が残り続ける状態を有界にする倍率。
// 既定 registry には IdleTimeoutGuard を登録せず、通常の OpenCode 呼び出しでは
// 親ステップの wall-clock deadline のみを安全装置として使う。
const STALE_IN_FLIGHT_TOOL_FACTOR = 6;

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
  /** in-flight のツール呼び出しキー → 登録時刻。時刻は stale 判定にだけ使う。 */
  private readonly inFlightToolCalls = new Map<string, number>();
  private readonly staleAfterMs: number;

  constructor(private readonly timeoutMs: number) {
    this.staleAfterMs = timeoutMs * STALE_IN_FLIGHT_TOOL_FACTOR;
  }

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
    if (this.inFlightToolCalls.has(key)) return;
    this.inFlightToolCalls.set(key, Date.now());
  }

  private arm(): void {
    if (this.onVerdict === undefined) return;
    this.disarm();
    // 長時間のツール呼び出しの間、OpenCode は
    // tool_use から tool_result までイベントを1つも流さない。この無音を
    // アイドルと判定すると健全な実行を切ってしまうため、in-flight のツール
    // 呼び出しが1つでもある間はアイドル計測をしない。
    const staleDeadline = this.earliestStaleDeadline();
    if (staleDeadline !== undefined) {
      // ただし terminal イベントを取りこぼすと in-flight が残り続ける。無音が
      // 続くと arm() も呼ばれないので、stale 期限にタイマーを置いて自力で
      // 除去し、劣化を有界にする（永久停止させない）。
      this.timeoutId = this.schedule(() => {
        this.pruneStaleToolCalls();
        this.arm();
      }, staleDeadline - Date.now());
      return;
    }
    this.timeoutId = this.schedule(() => {
      this.onVerdict?.({
        action: 'fail',
        reason: describeOpenCodeIdleTimeout(this.timeoutMs),
      });
    }, this.timeoutMs);
  }

  private earliestStaleDeadline(): number | undefined {
    if (this.inFlightToolCalls.size === 0) return undefined;
    return Math.min(...this.inFlightToolCalls.values()) + this.staleAfterMs;
  }

  private pruneStaleToolCalls(): void {
    const staleBefore = Date.now() - this.staleAfterMs;
    for (const [key, registeredAt] of this.inFlightToolCalls) {
      if (registeredAt <= staleBefore) this.inFlightToolCalls.delete(key);
    }
  }

  private schedule(handler: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const timeoutId = setTimeout(handler, Math.max(delayMs, 0));
    timeoutId.unref();
    return timeoutId;
  }

  private disarm(): void {
    if (this.timeoutId === undefined) return;
    clearTimeout(this.timeoutId);
    this.timeoutId = undefined;
  }
}
