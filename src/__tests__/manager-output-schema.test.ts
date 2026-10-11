import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toManagerOutputSchema } from '../features/manager/outputSchema.js';

describe('manager provider output schema', () => {
  it('omits the schema declaration while retaining response constraints', () => {
    const schema = toManagerOutputSchema(z.object({ message: z.string().min(1), summary: z.null() }).strict());
    expect(schema).not.toHaveProperty('$schema');
    expect(schema).toMatchObject({
      type: 'object', additionalProperties: false, required: ['message', 'summary'],
      properties: { message: { type: 'string', minLength: 1 }, summary: { type: 'null' } },
    });
  });

  it('emits draft-07 tuple items instead of draft 2020-12 prefixItems', () => {
    const schema = toManagerOutputSchema(z.tuple([z.string(), z.number()]));
    expect(schema).toMatchObject({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] });
    expect(schema).not.toHaveProperty('prefixItems');
    expect(schema).not.toHaveProperty('$schema');
  });
});
