import { z } from 'zod';

/**
 * Converts a manager response schema to the JSON Schema passed to providers.
 * Claude Code rejects the draft 2020-12 `$schema` URI that Zod emits by default,
 * so the schema is emitted as draft-07 without the `$schema` declaration.
 */
export function toManagerOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(jsonSchema).filter(([key]) => key !== '$schema'));
}
