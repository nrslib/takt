import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { appendNdjsonLine, type NdjsonRecord, type NdjsonWorkflowStart } from '../fs/index.js';
import { createLogger } from '../../shared/utils/debug.js';
import {
  mapSpanEndToNdjson,
  mapSpanStartToNdjson,
  type SpanSnapshot,
} from '../../core/logging/span-to-ndjson-mapper.js';

const log = createLogger('session-log-span-processor');

export interface SessionLogSpanProcessorOptions {
  runId: string;
  shadowLogPath: string;
  sanitizedTask: string;
  workflowName: string;
}

export class SessionLogSpanProcessor implements SpanProcessor {
  private readonly registrations = new Map<string, SessionLogSpanProcessorOptions>();
  // Judge-stage records whose parent phase span has not emitted its phase_start
  // yet. Phase spans defer phase_start to onEnd (prompt-part attributes are only
  // populated then), but judge-stage child spans end *before* their parent phase
  // span. Buffering keeps the canonical order phase_start -> judge_stage(s) ->
  // phase_complete. Keyed by `${runId} ${phaseExecutionId}`.
  private readonly pendingJudgeStages = new Map<string, NdjsonRecord[]>();

  constructor(options?: SessionLogSpanProcessorOptions) {
    if (options) {
      this.register(options);
    }
  }

  register(options: SessionLogSpanProcessorOptions): () => void {
    if (this.registrations.has(options.runId)) {
      // A live run already owns this runId. Overwriting would misroute its
      // shadow records and emit a second workflow_start, so keep the original.
      log.warn('Ignoring duplicate shadow session log registration', {
        runId: options.runId,
        shadowLogPath: options.shadowLogPath,
      });
      return () => {};
    }
    this.registrations.set(options.runId, options);
    const startRecord: NdjsonWorkflowStart = {
      type: 'workflow_start',
      task: options.sanitizedTask,
      workflowName: options.workflowName,
      startTime: new Date().toISOString(),
    };
    this.safeAppend(options, startRecord);
    return () => {
      this.registrations.delete(options.runId);
    };
  }

  onStart(span: Span, _parentContext: Context): void {
    const options = this.optionsForSpan(span);
    if (!options) {
      return;
    }
    if (span.name.startsWith('phase.')) {
      // Mark the phase open so judge-stage children buffer until phase_start.
      const key = this.phaseBufferKey(options.runId, span);
      if (key) {
        this.pendingJudgeStages.set(key, []);
      }
      return;
    }
    const record = mapSpanStartToNdjson(toSpanSnapshot(span));
    this.safeAppend(options, record);
  }

  onEnd(span: ReadableSpan): void {
    const options = this.optionsForSpan(span);
    if (!options) {
      return;
    }
    const snapshot = toSpanSnapshot(span);
    if (span.name.startsWith('phase.')) {
      // Emit phase_start (deferred so prompt-part attributes are populated),
      // then flush buffered judge-stage records, then phase_complete.
      this.safeAppend(options, mapSpanStartToNdjson(snapshot));
      const key = this.phaseBufferKey(options.runId, span);
      if (key) {
        const buffered = this.pendingJudgeStages.get(key);
        this.pendingJudgeStages.delete(key);
        for (const record of buffered ?? []) {
          this.safeAppend(options, record);
        }
      }
      this.safeAppend(options, mapSpanEndToNdjson(snapshot));
      return;
    }
    if (span.name.startsWith('judge_stage.')) {
      const key = this.phaseBufferKey(options.runId, span);
      const buffer = key ? this.pendingJudgeStages.get(key) : undefined;
      const record = mapSpanEndToNdjson(snapshot);
      if (buffer && record) {
        buffer.push(record);
        return;
      }
      this.safeAppend(options, record);
      return;
    }
    this.safeAppend(options, mapSpanEndToNdjson(snapshot));
  }

  private phaseBufferKey(runId: string, span: ReadableSpan): string | undefined {
    const phaseExecutionId = span.attributes['takt.phase.execution_id'];
    return typeof phaseExecutionId === 'string' ? `${runId} ${phaseExecutionId}` : undefined;
  }

  private optionsForSpan(span: ReadableSpan): SessionLogSpanProcessorOptions | undefined {
    const runId = span.attributes['takt.run.id'];
    return typeof runId === 'string' ? this.registrations.get(runId) : undefined;
  }

  private safeAppend(options: SessionLogSpanProcessorOptions, record: NdjsonRecord | undefined): void {
    if (!record) {
      return;
    }
    try {
      appendNdjsonLine(options.shadowLogPath, record);
    } catch (error) {
      log.error('Failed to append shadow session log record', {
        shadowLogPath: options.shadowLogPath,
        recordType: record.type,
        error,
      });
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.registrations.clear();
    this.pendingJudgeStages.clear();
  }
}

function toSpanSnapshot(span: ReadableSpan): SpanSnapshot {
  return {
    name: span.name,
    attributes: span.attributes,
    startTime: span.startTime,
    endTime: span.endTime,
  };
}
