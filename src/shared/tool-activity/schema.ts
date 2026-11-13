import { z } from 'zod/v4';
import type { ToolActivityEntry, ToolActivityEvent, ToolActivityHistoryState, ToolActivityTurnState, ToolActivityTurnUpdate } from './types.js';

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

const key = z.string().regex(/^[1-9]\d*$/);

export const ToolActivityEntrySchema = z.object({ key, context: context.optional(), toolId: toolId.optional(),
  tool: z.string(), input, output: z.string(), result: z.string().optional(),
  status: z.enum(['running', 'success', 'failure']), association: z.enum(['matched', 'unmatched']),
  startedAt: z.number().optional(), completedAt: z.number().optional(),
  startSequence: sequence.optional(), completionSequence: sequence.optional(),
}).strict();

export const ToolActivityHistoryStateSchema = z.object({ entries: z.array(ToolActivityEntrySchema), sequence }).strict()
  .refine((state) => new Set(state.entries.map((item) => item.key)).size === state.entries.length
    && state.entries.every((item) => (item.startSequence ?? 0) <= state.sequence
      && (item.completionSequence ?? 0) <= state.sequence)) satisfies z.ZodType<ToolActivityHistoryState>;

const generation = sequence.refine((value) => value > 0);
const belongsToTurn = (entries: readonly ToolActivityEntry[], turn: { operationId: string; generation: number }): boolean =>
  entries.every((item) => item.context?.operationId === turn.operationId && item.context.generation === turn.generation);

export const ToolActivityTurnStateSchema = z.object({ operationId: id, generation,
  finished: z.boolean(), history: ToolActivityHistoryStateSchema }).strict()
  .refine((state) => belongsToTurn(state.history.entries, state)
    && (!state.finished || state.history.entries.every((item) => item.status !== 'running'))) satisfies z.ZodType<ToolActivityTurnState>;

export const ToolActivityTurnUpdateSchema = z.object({ operationId: id, generation, previousSequence: sequence, sequence,
  entries: z.array(ToolActivityEntrySchema), output: z.object({ key, text: z.string() }).strict().optional() }).strict()
  .refine((update) => update.previousSequence < update.sequence && belongsToTurn(update.entries, update)
    && new Set(update.entries.map((item) => item.key)).size === update.entries.length
    && update.entries.every((item) => (item.startSequence ?? 0) <= update.sequence && (item.completionSequence ?? 0) <= update.sequence)) satisfies z.ZodType<ToolActivityTurnUpdate>;
