import { randomUUID } from 'node:crypto';
import type { TurnIdentity } from '../../core/daemon/messages.js';
import { MAX_TOOL_DESCRIPTION_LENGTH, type ConversationActivity, type ConversationToolEvent } from '../../shared/types/conversation-activity.js';
import type { ToolActivityEntry, ToolActivityTurnState } from '../../shared/tool-activity/types.js';
import type { PortOutput } from '../manager/conversationPort.js';
import {
  createBoundedSensitiveValues, createSensitiveTextStreamRedactor, sanitizeSensitiveValueWithKnownValues, type SensitiveTextStreamRedactor,
} from '../../shared/utils/sensitiveText.js';
import { sanitizeNormalizedToolResultText, toolResultSensitiveValues } from '../../shared/tool-activity/sanitize.js';
import { TerminalTextStream } from '../../shared/utils/terminal-text-stream.js';
import { LIVE_TOOL_OUTPUT_LIMIT, RETAINED_TOOL_OUTPUT_BYTES, limitToolOutput } from '../../shared/tool-activity/outputLimit.js';

interface ActiveTool {
  entry: ToolActivityEntry;
  redactor: SensitiveTextStreamRedactor;
  terminal: TerminalTextStream;
  outputCount: number;
}

/** manager 向けのマスクと集約はここで完了し、下流には確定した表現だけを渡す。 */
export class ToolTurn {
  private readonly active = new Map<string, ActiveTool>();
  private readonly completed: ToolActivityEntry[] = [];
  private readonly values = createBoundedSensitiveValues();

  constructor(private readonly turn: TurnIdentity) {}

  apply(message: ConversationToolEvent): PortOutput[] {
    const event = message.event;
    if (event.toolActivity?.operationId !== this.turn.operationId || event.toolActivity.generation !== this.turn.generation) {
      throw new Error('Tool event turn mismatch');
    }
    const ids = event.type === 'tool_result'
      ? [...new Set([event.data.id, ...(event.data.completedToolIds ?? [])])]
      : [event.data.id];
    if (ids.some((id) => id === '')) throw new Error('Missing tool identity');
    if (event.type === 'tool_use') this.values.collect(event.data.input);
    const normalized = toolResultSensitiveValues(this.values);
    const outputs: PortOutput[] = [];
    const publishOutput = (tool: ActiveTool, text: string): void => {
      if (tool.outputCount++ >= LIVE_TOOL_OUTPUT_LIMIT) return;
      outputs.push({ kind: 'tool_output', key: tool.entry.key, text,
        tail: tool.outputCount < LIVE_TOOL_OUTPUT_LIMIT ? tool.redactor.preview(normalized) : '' });
    };
    for (const id of ids) {
      const identity = JSON.stringify([event.toolActivity.callId, id]);
      let tool = this.active.get(identity);
      if (tool === undefined) {
        if (this.completed.some((entry) => entry.toolId === id && entry.context?.callId === event.toolActivity?.callId)) continue;
        const entry: ToolActivityEntry = { key: randomUUID(), toolId: id,
          context: { ...event.toolActivity }, tool: event.type === 'tool_result' ? 'Tool' : sanitizeNormalizedToolResultText(event.data.tool, normalized),
          input: {}, output: '', status: 'running', association: event.type === 'tool_use' ? 'matched' : 'unmatched',
          startedAt: Date.now() };
        tool = { entry, redactor: createSensitiveTextStreamRedactor(), terminal: new TerminalTextStream(), outputCount: 0 };
        this.active.set(identity, tool);
        if (event.type === 'tool_output') outputs.push({ kind: 'tool_started', entry: { ...entry } });
      }
      if (event.type === 'tool_use') {
        tool.entry = { ...tool.entry, tool: sanitizeNormalizedToolResultText(event.data.tool, normalized),
          input: sanitizeSensitiveValueWithKnownValues(event.data.input, normalized) as Record<string, unknown>, association: 'matched' };
        outputs.push({ kind: 'tool_started', entry: { ...tool.entry } });
      } else if (event.type === 'tool_output') {
        const text = tool.redactor.write(tool.terminal.write(event.data.output), normalized);
        tool.entry = { ...tool.entry, output: limitToolOutput(tool.entry.output + text, RETAINED_TOOL_OUTPUT_BYTES) };
        publishOutput(tool, text);
      } else if (event.type === 'tool_result') {
        const output = tool.entry.output + tool.redactor.flush(normalized);
        const values = toolResultSensitiveValues(event.data.content);
        values.collect(normalized);
        const result = sanitizeNormalizedToolResultText(event.data.content, values);
        const entry: ToolActivityEntry = { ...tool.entry, status: event.data.isError ? 'failure' : 'success', completedAt: Date.now(),
          output: result === '' ? limitToolOutput(output, RETAINED_TOOL_OUTPUT_BYTES) : '',
          result: limitToolOutput(result, RETAINED_TOOL_OUTPUT_BYTES) };
        this.active.delete(identity);
        this.completed.push(entry);
        outputs.push({ kind: 'tool_completed', entry });
      }
    }
    return outputs;
  }

  maskActivity(activity: ConversationActivity): ConversationActivity {
    if (activity.kind !== 'tool') return activity;
    const normalized = toolResultSensitiveValues(this.values);
    const tool = sanitizeNormalizedToolResultText(activity.tool, normalized);
    const description = activity.description === undefined ? undefined
      : sanitizeNormalizedToolResultText(activity.description, normalized)
        .slice(0, MAX_TOOL_DESCRIPTION_LENGTH).replace(/[\uD800-\uDBFF]$/u, '');
    return { kind: 'tool', tool, ...(description === undefined || description === '' ? {} : { description }) };
  }

  snapshot(): ToolActivityTurnState {
    return { operationId: this.turn.operationId, generation: this.turn.generation, finished: false,
      history: { entries: structuredClone([...this.completed, ...[...this.active.values()].map(({ entry }) => ({ ...entry, output: '' }))]) } };
  }
}
