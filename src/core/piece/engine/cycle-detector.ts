/**
 * Cycle detection for loop monitors.
 *
 * Tracks movement execution history and detects when a specific cycle
 * of movements has been repeated a configured number of times (threshold).
 *
 * Example:
 *   cycle: [ai_review, ai_fix], threshold: 3
 *   History: ai_review → ai_fix → ai_review → ai_fix → ai_review → ai_fix
 *                                                                     ↑
 *                                                              3 cycles → trigger
 */

import type { LoopMonitorConfig } from '../../models/types.js';

/** Result of checking a single loop monitor */
export interface CycleCheckResult {
  /** Whether the threshold has been reached */
  triggered: boolean;
  /** Current number of completed cycles */
  cycleCount: number;
  /** The loop monitor config that was triggered (if triggered) */
  monitor?: LoopMonitorConfig;
}

/**
 * Tracks movement execution history and detects cyclic patterns
 * as defined by loop_monitors configuration.
 */
export class CycleDetector {
  /** Movement execution history (names in order) */
  private history: string[] = [];
  private monitors: LoopMonitorConfig[];

  constructor(monitors: LoopMonitorConfig[] = []) {
    this.monitors = monitors;
  }

  /**
   * Record a movement completion and check if any cycle threshold is reached.
   *
   * The detection logic works as follows:
   * 1. The movement name is appended to the history
   * 2. For each monitor, we check if the cycle pattern has been completed
   *    by looking at the tail of the history
   * 3. A cycle is "completed" when the last N entries in history match
   *    the cycle pattern repeated `threshold` times
   *
   * @param movementName The name of the movement that just completed
   * @returns CycleCheckResult indicating if any monitor was triggered
   */
  recordAndCheck(movementName: string): CycleCheckResult {
    this.history.push(movementName);

    for (const monitor of this.monitors) {
      const result = this.checkMonitor(monitor);
      if (result.triggered) {
        return result;
      }
    }

    return { triggered: false, cycleCount: 0 };
  }

  /**
   * Check a single monitor against the current history.
   *
   * A cycle is detected when the last element of the history matches the
   * last element of the cycle, and looking backwards we can find exactly
   * `threshold` complete cycles.
   */
  private checkMonitor(monitor: LoopMonitorConfig): CycleCheckResult {
    const { cycle, threshold } = monitor;
    const cycleLen = cycle.length;

    // The cycle's last step must match the most recent movement
    const lastStep = cycle[cycleLen - 1];
    if (this.history[this.history.length - 1] !== lastStep) {
      return { triggered: false, cycleCount: 0 };
    }

    // Need at least threshold * cycleLen entries to check
    const requiredLen = threshold * cycleLen;
    if (this.history.length < requiredLen) {
      return { triggered: false, cycleCount: 0 };
    }

    // Count complete cycles from the end of history backwards
    let cycleCount = 0;
    let pos = this.history.length;

    while (pos >= cycleLen) {
      // Check if the last cycleLen entries match the cycle pattern
      let matches = true;
      for (let i = 0; i < cycleLen; i++) {
        if (this.history[pos - cycleLen + i] !== cycle[i]) {
          matches = false;
          break;
        }
      }

      if (matches) {
        cycleCount++;
        pos -= cycleLen;
      } else {
        break;
      }
    }

    if (cycleCount >= threshold) {
      return { triggered: true, cycleCount, monitor };
    }

    return { triggered: false, cycleCount };
  }

  /**
   * Reset the history after a judge intervention.
   * This prevents the same cycle from immediately triggering again.
   */
  reset(): void {
    this.history = [];
  }

  /**
   * Get the current movement history (for debugging/testing).
   */
  getHistory(): readonly string[] {
    return this.history;
  }
}
