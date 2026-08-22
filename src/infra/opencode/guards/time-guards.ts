import type { OpenCodeStreamEvent } from '../OpenCodeStreamHandler.js';
import {
  isOpenCodeToolTerminal,
  openCodeToolCallKey,
  readOpenCodeToolPart,
} from './tool-events.js';
import type { OpenCodeGuard, OpenCodeGuardLifecycleScope, OpenCodeGuardVerdict } from './types.js';
import { createPartTimeoutReason } from '../../../shared/types/agent-failure.js';
import { STALE_IN_FLIGHT_TOOL_FACTOR } from '../../../shared/types/provider-deadline.js';

export { STALE_IN_FLIGHT_TOOL_FACTOR } from '../../../shared/types/provider-deadline.js';

export function describeOpenCodeIdleTimeout(timeoutMs: number): string {
  return `OpenCode stream timed out after ${Math.round(timeoutMs / 60000)} minutes of inactivity`;
}

// 正当な長時間 tool を通常の無応答として切らず、終端イベント欠落だけを
// 有界にする。既存の call timeout を基準にすることで、別設定の解決経路を増やさない。
class InFlightToolTracker {
  readonly #startedAtByKey = new Map<string, number>();

  observe(event: OpenCodeStreamEvent): void {
    const toolPart = readOpenCodeToolPart(event);
    if (toolPart === undefined) return;
    const key = openCodeToolCallKey(toolPart);
    if (isOpenCodeToolTerminal(toolPart)) {
      this.#startedAtByKey.delete(key);
      return;
    }
    if (!this.#startedAtByKey.has(key)) {
      this.#startedAtByKey.set(key, Date.now());
    }
  }

  clear(): void {
    this.#startedAtByKey.clear();
  }

  earliestStaleDeadline(staleAfterMs: number): number | undefined {
    if (this.#startedAtByKey.size === 0) return undefined;
    return Math.min(...this.#startedAtByKey.values()) + staleAfterMs;
  }

  pruneStale(staleAfterMs: number): void {
    const staleBefore = Date.now() - staleAfterMs;
    for (const [key, startedAt] of this.#startedAtByKey) {
      if (startedAt <= staleBefore) this.#startedAtByKey.delete(key);
    }
  }
}

export class InactivityTimeoutGuard implements OpenCodeGuard {
  readonly id = 'inactivity-timeout';
  readonly layer = 'time' as const;
  private timeoutId: ReturnType<typeof setTimeout> | undefined;
  private onVerdict: ((verdict: OpenCodeGuardVerdict) => void) | undefined;
  private readonly inFlightTools = new InFlightToolTracker();
  private readonly staleAfterMs: number;

  constructor(private readonly timeoutMs: number) {
    this.staleAfterMs = timeoutMs * STALE_IN_FLIGHT_TOOL_FACTOR;
  }

  start(scope: OpenCodeGuardLifecycleScope, onVerdict: (verdict: OpenCodeGuardVerdict) => void): void {
    if (scope === 'call') {
      this.onVerdict = onVerdict;
    } else {
      this.inFlightTools.clear();
    }
    if (this.onVerdict === undefined) return;
    this.arm();
  }

  onEvent(event: OpenCodeStreamEvent): OpenCodeGuardVerdict | undefined {
    this.inFlightTools.observe(event);
    this.arm();
    return undefined;
  }

  stop(scope: OpenCodeGuardLifecycleScope): void {
    if (scope !== 'call') return;
    this.disarm();
    this.inFlightTools.clear();
    this.onVerdict = undefined;
  }

  private arm(): void {
    this.disarm();
    const staleDeadline = this.inFlightTools.earliestStaleDeadline(this.staleAfterMs);
    this.timeoutId = staleDeadline === undefined
      ? this.schedule(() => this.fail(), this.timeoutMs)
      : this.schedule(() => {
          this.inFlightTools.pruneStale(this.staleAfterMs);
          this.fail();
        }, staleDeadline - Date.now());
  }

  private fail(): void {
    this.onVerdict?.({
      action: 'fail',
      reason: createPartTimeoutReason(this.timeoutMs),
      abortKind: 'deadline',
    });
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

export class IdleTimeoutGuard implements OpenCodeGuard {
  readonly id = 'idle-timeout';
  readonly layer = 'time' as const;
  private timeoutId: ReturnType<typeof setTimeout> | undefined;
  private onVerdict: ((verdict: OpenCodeGuardVerdict) => void) | undefined;
  private readonly inFlightTools = new InFlightToolTracker();
  private readonly staleAfterMs: number;

  constructor(private readonly timeoutMs: number) {
    this.staleAfterMs = timeoutMs * STALE_IN_FLIGHT_TOOL_FACTOR;
  }

  start(scope: OpenCodeGuardLifecycleScope, onVerdict: (verdict: OpenCodeGuardVerdict) => void): void {
    if (scope !== 'attempt') return;
    this.inFlightTools.clear();
    this.onVerdict = onVerdict;
    this.arm();
  }

  onEvent(event: OpenCodeStreamEvent): OpenCodeGuardVerdict | undefined {
    this.inFlightTools.observe(event);
    this.arm();
    return undefined;
  }

  stop(scope: OpenCodeGuardLifecycleScope): void {
    if (scope !== 'attempt') return;
    this.disarm();
    this.inFlightTools.clear();
    this.onVerdict = undefined;
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
        this.inFlightTools.pruneStale(this.staleAfterMs);
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
    return this.inFlightTools.earliestStaleDeadline(this.staleAfterMs);
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
