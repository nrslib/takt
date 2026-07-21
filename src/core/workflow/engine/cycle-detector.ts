/**
 * Cycle detection for loop monitors.
 *
 * Tracks step execution history and detects when a specific cycle
 * of steps has been repeated a configured number of times (threshold).
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
 * Tracks step execution history and detects cyclic patterns
 * as defined by loop_monitors configuration.
 */
export class CycleDetector {
  /** Step execution history (names in order) */
  private history: string[] = [];
  private monitors: LoopMonitorConfig[];

  constructor(monitors: LoopMonitorConfig[] = []) {
    this.monitors = monitors;
  }

  /**
   * Record a step completion and check if any cycle threshold is reached.
   *
   * The detection logic works as follows:
   * 1. The step name is appended to the history
   * 2. For each monitor whose first step is the proposed next step, we check
   *    if the cycle pattern has been completed by looking at the tail of the
   *    history
   * 3. A cycle is "completed" when the last N entries in history match
   *    the cycle pattern repeated `threshold` times
   *
   * @param stepName The name of the step that just completed
   * @param nextStep The natural transition proposed after the completed step
   * @returns CycleCheckResult indicating if any monitor was triggered
   */
  recordAndCheck(stepName: string, nextStep: string): CycleCheckResult {
    this.history.push(stepName);

    for (const monitor of this.monitors) {
      const result = this.checkMonitor(monitor, nextStep);
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
  private checkMonitor(monitor: LoopMonitorConfig, nextStep: string): CycleCheckResult {
    const { cycle, threshold } = monitor;
    const cycleLen = cycle.length;

    // A completed cycle is only a loop when the natural transition is about
    // to enter the same cycle again. If the workflow is already leaving the
    // cycle, the monitor must not override that progress.
    if (nextStep !== cycle[0]) {
      return { triggered: false, cycleCount: 0 };
    }

    // The cycle's last step must match the most recent step
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
   * Get the current step history (for debugging/testing).
   */
  getHistory(): readonly string[] {
    return this.history;
  }
}
