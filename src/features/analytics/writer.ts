import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalyticsEvent, RoutingDecisionEvent } from './events.js';

export interface AnalyticsWriterOptions {
  routingEventsDir?: string;
}

export class AnalyticsWriter {
  private static instance: AnalyticsWriter | null = null;

  private enabled = false;
  private eventsDir: string | null = null;
  private routingEventsDir: string | null = null;

  private constructor() {}

  static getInstance(): AnalyticsWriter {
    if (!AnalyticsWriter.instance) {
      AnalyticsWriter.instance = new AnalyticsWriter();
    }
    return AnalyticsWriter.instance;
  }

  static resetInstance(): void {
    AnalyticsWriter.instance?.dispose();
    AnalyticsWriter.instance = null;
  }

  init(enabled: boolean, eventsDir: string, options: AnalyticsWriterOptions = {}): void {
    this.dispose();
    this.enabled = enabled;
    this.eventsDir = eventsDir;
    this.routingEventsDir = options.routingEventsDir ?? null;

    if (this.enabled) {
      if (!existsSync(this.eventsDir)) {
        mkdirSync(this.eventsDir, { recursive: true });
      }
    }
    if (this.routingEventsDir !== null && !existsSync(this.routingEventsDir)) {
      mkdirSync(this.routingEventsDir, { recursive: true });
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  write(event: AnalyticsEvent): void {
    if (event.type === 'routing_decision') {
      this.writeRoutingDecision(event);
      return;
    }

    if (!this.enabled || !this.eventsDir) {
      return;
    }

    appendJsonlEvent(this.eventsDir, event);
  }

  private writeRoutingDecision(event: RoutingDecisionEvent): void {
    if (this.routingEventsDir !== null) {
      appendJsonlEvent(this.routingEventsDir, event);
    }
  }

  private dispose(): void {
    this.routingEventsDir = null;
  }
}

function formatDate(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

function appendJsonlEvent(eventsDir: string, event: AnalyticsEvent): void {
  const filePath = join(eventsDir, `${formatDate(event.timestamp)}.jsonl`);
  appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
}

// ---- Module-level convenience functions ----

export function initAnalyticsWriter(enabled: boolean, eventsDir: string, options?: AnalyticsWriterOptions): void {
  AnalyticsWriter.getInstance().init(enabled, eventsDir, options);
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
