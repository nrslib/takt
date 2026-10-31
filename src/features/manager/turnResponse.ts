import { z } from 'zod/v4';
import { GoalSummarySchema } from '../../infra/goals/schema.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { toDisplayText } from '../tui/displayText.js';
import { toManagerOutputSchema, toStrictManagerOutputSchema } from './outputSchema.js';
import type { AgentResponse } from '../../core/models/response.js';

const summarySchema = GoalSummarySchema.extend({ repositoryDirectory: z.string().min(1).optional() })
  .refine((summary) => [
    summary.objective, ...summary.outOfScope, ...summary.acceptanceCriteria, ...summary.constraints,
    ...(summary.repositoryDirectory === undefined ? [] : [summary.repositoryDirectory]),
    ...(summary.startBranch === undefined ? [] : [summary.startBranch]),
    ...(summary.integrationBranch === undefined ? [] : [summary.integrationBranch]),
  ].every((value) => toDisplayText(value) === value), 'Summary contains unsafe display characters');
const responseSchema = z.object({ message: z.string().min(1), summary: summarySchema.nullable() }).strict();

export function validateManagerSummary(value: unknown) {
  return summarySchema.parse(value);
}
export const managerOutputSchema = toManagerOutputSchema(responseSchema);
const codexOutputSchema = toStrictManagerOutputSchema(z.object({
  message: z.string(),
  summary: z.object({
    repositoryDirectory: z.string().nullable(),
    objective: z.string(),
    outOfScope: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
    constraints: z.array(z.string()),
    startBranch: z.string().nullable(),
    integrationBranch: z.string().nullable(),
  }).strict().nullable(),
}).strict());
const codexResponseSchema = responseSchema.extend({
  summary: z.preprocess((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const summary = { ...value } as Record<string, unknown>;
    if (summary.repositoryDirectory === null) delete summary.repositoryDirectory;
    if (summary.startBranch === null) delete summary.startBranch;
    if (summary.integrationBranch === null) delete summary.integrationBranch;
    return summary;
  }, summarySchema.nullable()),
});

export function getManagerOutputSchema(providerType: ProviderType): Record<string, unknown> {
  return providerType === 'codex' ? codexOutputSchema : managerOutputSchema;
}

function normalizeResponseContent(content: string): unknown {
  const trimmed = content.trimStart();
  const looksLikeArray = /^\[\s*(?:\]|\{|\[|"|-|\d|true\b|false\b|null\b|$)/u.test(trimmed);
  if (trimmed.startsWith('{') || looksLikeArray) return JSON.parse(content);
  return { message: content, summary: null };
}

export function parseManagerResponse(response: AgentResponse, provider: ProviderType) {
  const raw: unknown = response.structuredOutput ?? normalizeResponseContent(response.content);
  return (provider === 'codex' ? codexResponseSchema : responseSchema).parse(raw);
}
