import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import type { AgentResponse } from '../../core/models/response.js';
import type { ProviderType } from '../../infra/providers/types.js';
import { getManagerOutputSchema, parseManagerResponse } from '../manager/turnResponse.js';

const managerIdSchema = z.string().regex(/^manager-[a-f0-9]{64}$/);
const repositorySchema = z.string().min(1).refine(isAbsolute);
const envelopeSchema = z.object({ message: z.string().min(1), summary: z.unknown() }).strict();

interface OutputSchema {
  type?: string;
  properties?: Record<string, OutputSchema>;
  anyOf?: OutputSchema[];
  required?: string[];
  pattern?: string;
}

export function getDirectorOutputSchema(provider: ProviderType): Record<string, unknown> {
  const schema = structuredClone(getManagerOutputSchema(provider));
  const root = schema as OutputSchema;
  const summary = root.properties?.summary?.anyOf?.find((branch) => branch.type === 'object');
  if (summary?.properties === undefined || summary.required === undefined) throw new Error('Missing goal summary output schema');
  summary.properties.managerId = { type: 'string', pattern: '^manager-[a-f0-9]{64}$' };
  summary.properties.repositoryDirectory = { type: 'string' };
  summary.required = [...new Set([...summary.required, 'managerId', 'repositoryDirectory'])];
  return schema;
}

export function parseDirectorResponse(response: AgentResponse, provider: ProviderType) {
  const raw: unknown = response.structuredOutput ?? (response.content.trimStart().startsWith('{') ? JSON.parse(response.content) : undefined);
  if (raw === undefined) return { ...parseManagerResponse(response, provider), summary: null };
  const envelope = envelopeSchema.parse(raw);
  if (envelope.summary === null) return { ...parseManagerResponse({ ...response, structuredOutput: envelope }, provider), summary: null };
  const summary = z.record(z.string(), z.unknown()).parse(envelope.summary);
  const { managerId, ...content } = summary;
  const selectedManager = managerIdSchema.parse(managerId);
  const parsed = parseManagerResponse({ ...response, structuredOutput: { ...envelope, summary: content } }, provider);
  if (parsed.summary === null) throw new Error('Missing director goal summary');
  return { ...parsed, summary: { ...parsed.summary, managerId: selectedManager,
    repositoryDirectory: repositorySchema.parse(parsed.summary.repositoryDirectory) } };
}
