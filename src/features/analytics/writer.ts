/**
 * Analytics event writer — JSONL append-only with date-based rotation.
 *
 * Writes to ~/.takt/analytics/events/YYYY-MM-DD.jsonl when analytics.enabled = true.
 * Does nothing when disabled.
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalyticsEvent } from './events.js';

export class AnalyticsWriter {
  private static instance: AnalyticsWriter | null = null;

  private enabled = false;
  private eventsDir: string | null = null;

  private constructor() {}

  static getInstance(): AnalyticsWriter {
    if (!AnalyticsWriter.instance) {
      AnalyticsWriter.instance = new AnalyticsWriter();
    }
    return AnalyticsWriter.instance;
  }

  static resetInstance(): void {
    AnalyticsWriter.instance = null;
  }

  /**
   * Initialize writer.
   * @param enabled Whether analytics collection is active
   * @param eventsDir Absolute path to the events directory (e.g. ~/.takt/analytics/events)
   */
  init(enabled: boolean, eventsDir: string): void {
    this.enabled = enabled;
    this.eventsDir = eventsDir;

    if (this.enabled) {
      if (!existsSync(this.eventsDir)) {
        mkdirSync(this.eventsDir, { recursive: true });
      }
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Append an analytics event to the current day's JSONL file */
  write(event: AnalyticsEvent): void {
    if (!this.enabled || !this.eventsDir) {
      return;
    }

    const filePath = join(this.eventsDir, `${formatDate(event.timestamp)}.jsonl`);
    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
  }
}

function formatDate(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

// ---- Module-level convenience functions ----

export function initAnalyticsWriter(enabled: boolean, eventsDir: string): void {
  AnalyticsWriter.getInstance().init(enabled, eventsDir);
}

export function resetAnalyticsWriter(): void {
  AnalyticsWriter.resetInstance();
}

export function isAnalyticsEnabled(): boolean {
  return AnalyticsWriter.getInstance().isEnabled();
}

export function writeAnalyticsEvent(event: AnalyticsEvent): void {
  AnalyticsWriter.getInstance().write(event);
}
