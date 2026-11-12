import { z } from 'zod/v4';
import type { ToolActivityEvent, ToolActivityHistoryState, ToolActivityTurnState } from './types.js';

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(128);
const toolId = z.string();
const context = z.object({ callId: z.string(), operationId: z.string().optional(), generation: z.number().optional() }).strict();
const input = z.record(z.string(), z.unknown());

export const ToolActivityEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool_use'), data: z.object({ id: toolId, tool: z.string(), input }).strict(), toolActivity: context.optional() }).strict(),
  z.object({ type: z.literal('tool_result'), data: z.object({ id: toolId.optional(), completedToolIds: z.array(toolId).optional(),
    content: z.string(), isError: z.boolean() }).strict(), toolActivity: context.optional() }).strict(),
  z.object({ type: z.literal('tool_output'), data: z.object({ id: toolId.optional(), tool: z.string(), output: z.string() }).strict(),
    toolActivity: context.optional() }).strict(),
]) satisfies z.ZodType<ToolActivityEvent>;

const entry = z.object({ key: z.string().regex(/^[1-9]\d*$/), context: context.optional(), toolId: toolId.optional(),
  tool: z.string(), input, output: z.string(), outputTruncated: z.boolean().optional(), result: z.string().optional(),
  resultTruncated: z.boolean().optional(),
  status: z.enum(['running', 'success', 'failure']), association: z.enum(['matched', 'unmatched']),
  startedAt: z.number().optional(), completedAt: z.number().optional(),
  startSequence: sequence.optional(), completionSequence: sequence.optional(),
}).strict();

export const ToolActivityHistoryStateSchema = z.object({ entries: z.array(entry), sequence }).strict()
  .refine((state) => new Set(state.entries.map((item) => item.key)).size === state.entries.length
    && state.entries.every((item) => (item.startSequence ?? 0) <= state.sequence
      && (item.completionSequence ?? 0) <= state.sequence)) satisfies z.ZodType<ToolActivityHistoryState>;

export const ToolActivityTurnStateSchema = z.object({ operationId: id, generation: sequence.refine((value) => value > 0),
  finished: z.boolean(), eventIds: z.array(id), history: ToolActivityHistoryStateSchema }).strict()
  .refine((state) => new Set(state.eventIds).size === state.eventIds.length
    && state.history.entries.every((item) => item.context?.operationId === state.operationId
      && item.context.generation === state.generation && (!state.finished || item.status !== 'running'))) satisfies z.ZodType<ToolActivityTurnState>;
