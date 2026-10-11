import { z } from 'zod/v4';
import { GoalAnswerSchema, GoalDecisionSchema, GoalRecordObjectSchema, GoalSchema, GoalTaskResultSchema, type Goal } from './schema.js';
import { goalEventId } from './events.js';

const legacyEventSchema = z.object({
  taskName: z.string().min(1), runSlug: z.string().min(1), result: GoalTaskResultSchema,
  processed: z.boolean(), summary: z.string().optional(),
}).strict();
const legacyAnswerEventSchema = z.object({
  questionId: z.uuid(), answer: GoalAnswerSchema, processed: z.boolean(), summary: z.string().optional(),
}).strict();
const legacyDecisionSchema = z.object({ decision: z.enum(['integrate', 'complete']), reason: z.string().min(1), recordedAt: z.iso.datetime() }).strict();
const legacySchema = GoalRecordObjectSchema.omit({ executionStatus: true, acceptanceCriteriaVersion: true, operations: true }).extend({
  events: z.array(legacyEventSchema).optional(),
  answerEvents: z.array(legacyAnswerEventSchema).optional(),
  sessions: z.array(z.object({ provider: z.string(), sessionId: z.string().min(1) }).strict()).optional(),
  decisions: z.array(legacyDecisionSchema).optional(),
});

export function normalizeLegacyDecision(goalId: string, raw: unknown, index: number) {
  const decision = legacyDecisionSchema.parse(raw);
  return GoalDecisionSchema.parse({
    id: goalEventId(goalId, 'legacy_decision', [String(index)]), eventId: null, actor: null,
    operation: decision.decision, reason: decision.reason, recordedAt: decision.recordedAt,
    evidenceRefs: [], acceptanceCriteriaVersion: 1,
  });
}

export function normalizeSavedGoal(raw: unknown): Goal {
  if (raw !== null && typeof raw === 'object'
    && (Object.hasOwn(raw, 'executionStatus') || Object.hasOwn(raw, 'acceptanceCriteriaVersion') || Object.hasOwn(raw, 'operations'))) {
    return GoalSchema.parse(raw);
  }
  const old = legacySchema.parse(raw);
  const { answerEvents, events, decisions, ...goal } = old;
  delete goal.sessions;
  return GoalSchema.parse({
    ...goal, executionStatus: 'active', acceptanceCriteriaVersion: 1,
    ...(events === undefined && answerEvents === undefined ? {} : { events: [
      ...(events ?? []).map((event) => ({ ...event, kind: 'completion', id: goalEventId(old.id, 'completion', [event.taskName, event.runSlug]) })),
      ...(answerEvents ?? []).map((event) => ({ ...event, kind: 'answer', id: goalEventId(old.id, 'answer', [event.questionId]) })),
    ] }),
    ...(decisions === undefined ? {} : { decisions: decisions.map((decision, index) => normalizeLegacyDecision(old.id, decision, index)) }),
  });
}
