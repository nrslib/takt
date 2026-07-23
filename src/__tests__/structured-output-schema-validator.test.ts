import { describe, expect, it } from 'vitest';
import {
  StructuredOutputSchemaError,
  StructuredOutputValueValidationError,
  assertStructuredOutputSchema,
  validateStructuredOutputAgainstSchema,
} from '../core/workflow/engine/structured-output-schema-validator.js';

describe('structured output schema validator', () => {
  it('separates terminal schema compilation errors from model value issues', () => {
    expect(() => assertStructuredOutputSchema({
      type: 'not-a-json-schema-type',
    })).toThrow(StructuredOutputSchemaError);

    const schema = {
      type: 'object',
      properties: {
        first: { type: 'string' },
        second: { type: 'number' },
      },
      required: ['first', 'second'],
      additionalProperties: false,
    };
    let valueError: StructuredOutputValueValidationError | undefined;
    try {
      validateStructuredOutputAgainstSchema({ extra: true }, schema);
    } catch (error) {
      if (error instanceof StructuredOutputValueValidationError) {
        valueError = error;
      } else {
        throw error;
      }
    }

    expect(valueError?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '$.first', keyword: 'required' }),
      expect.objectContaining({ path: '$.second', keyword: 'required' }),
      expect.objectContaining({ path: '$.extra', keyword: 'additionalProperties' }),
    ]));
  });
});
