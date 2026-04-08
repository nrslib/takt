/**
 * Loop detection for workflow execution
 *
 * Detects when a workflow step is executed repeatedly without progress,
 * which may indicate an infinite loop.
 */

import type { LoopDetectionConfig } from '../../models/types.js';
import type { LoopCheckResult } from '../types.js';

/** Default loop detection settings */
const DEFAULT_LOOP_DETECTION: Required<LoopDetectionConfig> = {
  maxConsecutiveSameStep: 10,
  action: 'warn',
};

/**
 * Loop detector for tracking consecutive same-step executions.
 */
export class LoopDetector {
  private lastStepName: string | null = null;
  private consecutiveCount = 0;
  private config: Required<LoopDetectionConfig>;

  constructor(config?: LoopDetectionConfig) {
    this.config = {
      ...DEFAULT_LOOP_DETECTION,
      ...config,
    };
  }

  /**
   * Check if the given step execution would be a loop.
   * Updates internal tracking state.
   */
  check(stepName: string): LoopCheckResult {
    if (this.lastStepName === stepName) {
      this.consecutiveCount++;
    } else {
      this.consecutiveCount = 1;
      this.lastStepName = stepName;
    }

    const isLoop = this.consecutiveCount > this.config.maxConsecutiveSameStep;
    const shouldAbort = isLoop && this.config.action === 'abort';
    const shouldWarn = isLoop && this.config.action !== 'ignore';

    return {
      isLoop,
      count: this.consecutiveCount,
      shouldAbort,
      shouldWarn,
    };
  }

  /**
   * Reset the detector state.
   */
  reset(): void {
    this.lastStepName = null;
    this.consecutiveCount = 0;
  }

  /**
   * Get current consecutive count.
   */
  getConsecutiveCount(): number {
    return this.consecutiveCount;
  }
}
