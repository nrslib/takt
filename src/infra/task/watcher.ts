/**
 * Task directory watcher
 *
 * Polls .takt/tasks.yaml for pending tasks and invokes a callback when found.
 * Uses polling (not fs.watch) for cross-platform reliability.
 */

import { createLogger } from '../../shared/utils/index.js';
import { TaskRunner } from './runner.js';
import type { TaskInfo } from './types.js';

const log = createLogger('watcher');

export interface TaskWatcherOptions {
  /** Polling interval in milliseconds (default: 2000) */
  pollInterval?: number;
}

const DEFAULT_POLL_INTERVAL = 2000;

export class TaskWatcher {
  private runner: TaskRunner;
  private pollInterval: number;
  private running = false;
  private abortController: AbortController | null = null;

  constructor(projectDir: string, options?: TaskWatcherOptions) {
    this.runner = new TaskRunner(projectDir);
    this.pollInterval = options?.pollInterval ?? DEFAULT_POLL_INTERVAL;
  }

  /**
   * Start watching for tasks.
   * Resolves only when stop() is called.
   */
  async watch(onTask: (task: TaskInfo) => Promise<void>): Promise<void> {
    this.running = true;
    this.abortController = new AbortController();

    log.info('Watch started', { pollInterval: this.pollInterval });

    while (this.running) {
      const claimed = this.runner.claimNextTasks(1);
      const task = claimed[0];

      if (task) {
        log.info('Task found', { name: task.name });
        await onTask(task);
        // After task execution, immediately check for next task (no sleep)
        continue;
      }

      // No tasks: wait before next poll
      await this.sleep(this.pollInterval);
    }

    log.info('Watch stopped');
  }

  /** Stop watching */
  stop(): void {
    this.running = false;
    this.abortController?.abort();
  }

  /** Whether the watcher is currently active */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Sleep with abort support.
   * Resolves early if stop() is called.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.abortController?.signal;

      if (signal?.aborted) {
        resolve();
        return;
      }

      const timer = setTimeout(resolve, ms);

      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
