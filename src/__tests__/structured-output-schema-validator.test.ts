import { describe, expect, it } from 'vitest';
import {
  StructuredOutputSchemaError,
  StructuredOutputValueValidationError,
  assertStrictStructuredOutputSchema,
  assertStructuredOutputSchema,
  validateStructuredOutputAgainstSchema,
} from '../core/workflow/engine/structured-output-schema-validator.js';

function createStrictRoot(valueSchema: unknown): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      value: valueSchema,
    },
    required: ['value'],
    additionalProperties: false,
  };
}

function createComplexObjectConstSchema(value: unknown): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      name: { type: 'string' },
      metadata: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
        },
        required: ['count'],
        additionalProperties: false,
      },
    },
    required: ['name', 'metadata'],
    additionalProperties: false,
    const: value,
  };
}

function expectStrictSubsetRejection(
  schema: Record<string, unknown>,
  expectedMessage: string,
): void {
  expect(() => assertStructuredOutputSchema(schema)).not.toThrow();
  expect(() => assertStrictStructuredOutputSchema(schema)).toThrow(StructuredOutputSchemaError);
  expect(() => assertStrictStructuredOutputSchema(schema)).toThrow(expectedMessage);
}

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

  it.each([
    {
      name: 'a root property is omitted from required',
      schema: {
        type: 'object',
        properties: {
          required_value: { type: 'string' },
          optional_value: { type: 'string' },
        },
        required: ['required_value'],
        additionalProperties: false,
      },
      expectedMessage: 'missing: optional_value',
    },
    {
      name: 'a nested property is omitted from required',
      schema: {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: {
              value: { type: 'string' },
            },
            required: [],
            additionalProperties: false,
          },
        },
        required: ['nested'],
        additionalProperties: false,
      },
      expectedMessage: '$.nested must list every property in required (missing: value)',
    },
    {
      name: 'required lists a property that is not declared',
      schema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
        required: ['value', 'extra'],
        additionalProperties: false,
      },
      expectedMessage: 'unknown: extra',
    },
    {
      name: 'a nested object allows additional properties',
      schema: {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        required: ['nested'],
        additionalProperties: false,
      },
      expectedMessage: '$.nested must set additionalProperties to false',
    },
  ])('rejects a JSON Schema that is valid but not strict when $name', ({ schema, expectedMessage }) => {
    expectStrictSubsetRejection(schema, expectedMessage);
  });

  it('accepts the Codex and Claude raw structured output subset', () => {
    const schema = {
      $defs: {
        entry: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              const: 'entry',
              format: 'hostname',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      type: 'object',
      properties: {
        payload: {
          anyOf: [
            {
              $ref: '#/$defs/entry',
              description: 'An entry reference',
            },
            {
              type: 'array',
              items: {
                type: 'string',
                enum: ['ready', 'done'],
              },
            },
          ],
        },
        confidence: {
          anyOf: [
            { type: 'number' },
            { type: 'null' },
          ],
        },
        count: { type: 'integer' },
        enabled: { type: 'boolean' },
      },
      required: ['payload', 'confidence', 'count', 'enabled'],
      additionalProperties: false,
    };

    expect(() => assertStrictStructuredOutputSchema(schema)).not.toThrow();
  });

  it('accepts const on a typed nested schema', () => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot({ type: 'string', const: 'fixed' }),
    )).not.toThrow();
  });

  it.each([
    ['string', { type: 'string', enum: ['ready', 'done'] }],
    ['number', { type: 'number', enum: [1, 1.5] }],
    ['integer', { type: 'integer', enum: [1, 2] }],
    ['boolean', { type: 'boolean', enum: [true, false] }],
    ['null', { type: 'null', enum: [null] }],
    ['nullable string', { type: ['string', 'null'], enum: ['ready', null] }],
  ])('accepts primitive enum values matching the declared %s type', (_name, valueSchema) => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot(valueSchema),
    )).not.toThrow();
  });

  it.each([
    ['null', { type: 'null', const: null }],
    ['nullable object', {
      type: ['object', 'null'],
      properties: {},
      required: [],
      additionalProperties: false,
      const: null,
    }],
  ])('accepts a lossless JSON const matching the declared %s type', (_name, valueSchema) => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot(valueSchema),
    )).not.toThrow();
  });

  it.each([
    ['an object satisfying its schema', createComplexObjectConstSchema({
      name: 'entry',
      metadata: { count: 1 },
    })],
    ['an object missing a required property', createComplexObjectConstSchema({
      name: 'entry',
    })],
    ['an object containing an additional property', createComplexObjectConstSchema({
      name: 'entry',
      metadata: { count: 1 },
      extra: true,
    })],
    ['an object containing a nested type mismatch', createComplexObjectConstSchema({
      name: 'entry',
      metadata: { count: '1' },
    })],
    ['an array satisfying its items schema', {
      type: 'array',
      items: { type: 'number' },
      const: [1, 2],
    }],
    ['an array violating its items schema', {
      type: 'array',
      items: { type: 'number' },
      const: [1, '2'],
    }],
  ])('rejects a complex const containing %s', (_name, valueSchema) => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot(valueSchema),
    )).toThrow('const must be a lossless primitive JSON value');
  });

  it('accepts a standalone null schema in a nested anyOf branch', () => {
    expect(() => assertStrictStructuredOutputSchema(createStrictRoot({
      anyOf: [
        { type: 'number' },
        { type: 'null' },
      ],
    }))).not.toThrow();
  });

  it.each([
    ['allOf', [{ type: 'string' }]],
    ['not', { type: 'string' }],
    ['dependentRequired', { value: ['other'] }],
    ['dependentSchemas', { value: { type: 'string' } }],
    ['if', { type: 'string' }],
    ['then', { type: 'string' }],
    ['else', { type: 'string' }],
    ['oneOf', [{ type: 'string' }]],
    ['uniqueItems', true],
    ['contains', { type: 'string' }],
    ['propertyNames', { type: 'string' }],
    ['unevaluatedItems', false],
    ['unevaluatedProperties', false],
    ['definitions', { value: { type: 'string' } }],
    ['prefixItems', [{ type: 'string' }]],
    ['title', 'A title'],
    ['futureKeyword', true],
  ])('rejects the unsupported strict structured output keyword %s', (keyword, value) => {
    const schema = createStrictRoot({
      type: 'string',
      [keyword]: value,
    });

    expectStrictSubsetRejection(
      schema,
      `$.value uses unsupported keyword ${keyword}`,
    );
  });

  it.each([
    {
      name: 'the root uses anyOf',
      schema: {
        ...createStrictRoot({ type: 'string' }),
        anyOf: [
          createStrictRoot({ type: 'string' }),
          createStrictRoot({ type: 'number' }),
        ],
      },
      expectedMessage: '$ must not use anyOf',
    },
    {
      name: 'the root is nullable',
      schema: {
        type: ['object', 'null'],
        properties: {},
        required: [],
        additionalProperties: false,
      },
      expectedMessage: '$ must have type object',
    },
    {
      name: 'array items use tuple validation',
      schema: createStrictRoot({
        type: 'array',
        items: [{ type: 'string' }, { type: 'number' }],
      }),
      expectedMessage: '$.value.items must be a schema object',
    },
    {
      name: 'a nested object omits its type',
      schema: createStrictRoot({
        properties: {
          nested_value: { type: 'string' },
        },
        required: ['nested_value'],
        additionalProperties: false,
      }),
      expectedMessage: '$.value must declare type, anyOf, or $ref',
    },
    {
      name: 'a schema node is empty',
      schema: createStrictRoot({}),
      expectedMessage: '$.value must declare type, anyOf, or $ref',
    },
    {
      name: 'a schema node only declares enum',
      schema: createStrictRoot({ enum: ['ready', 'done'] }),
      expectedMessage: '$.value must declare type, anyOf, or $ref',
    },
    {
      name: 'a property uses a boolean schema',
      schema: createStrictRoot(true),
      expectedMessage: '$.value must be a schema object',
    },
    {
      name: 'array items use a boolean schema',
      schema: createStrictRoot({
        type: 'array',
        items: true,
      }),
      expectedMessage: '$.value.items must be a schema object',
    },
    {
      name: 'an anyOf branch uses a boolean schema',
      schema: createStrictRoot({
        anyOf: [
          { type: 'string' },
          false,
        ],
      }),
      expectedMessage: '$.value.anyOf[1] must be a schema object',
    },
    {
      name: '$defs is not an object map',
      schema: {
        ...createStrictRoot({ type: 'string' }),
        $defs: true,
      },
      expectedMessage: '$.$defs must be a schema object map',
    },
  ])('rejects an unsupported strict schema shape when $name', ({ schema, expectedMessage }) => {
    expectStrictSubsetRejection(schema, expectedMessage);
  });

  it.each([
    ['a non-null type array', ['string']],
    ['multiple non-null union members', ['string', 'number']],
  ])('rejects %s', (_name, type) => {
    expectStrictSubsetRejection(
      createStrictRoot({ type }),
      '$.value.type must be a supported type or nullable type union',
    );
  });

  it.each([
    ['string', 'minLength', 1],
    ['string', 'maxLength', 3],
    ['number', 'multipleOf', 2],
    ['number', 'minimum', 0],
    ['number', 'exclusiveMinimum', 0],
    ['number', 'maximum', 10],
    ['number', 'exclusiveMaximum', 10],
    ['array', 'minItems', 1],
    ['array', 'maxItems', 3],
    ['string', 'pattern', '^[a-z]+$'],
  ])('rejects %s schemas using the Claude raw unsupported %s constraint', (type, keyword, value) => {
    const schema = type === 'array'
      ? { type, items: { type: 'string' }, [keyword]: value }
      : { type, [keyword]: value };
    expectStrictSubsetRejection(
      createStrictRoot(schema),
      `$.value uses unsupported keyword ${keyword}`,
    );
  });

  it('rejects an unsupported raw string format', () => {
    const schema = createStrictRoot({ type: 'string', format: 'future-format' });

    expect(() => assertStrictStructuredOutputSchema(schema)).toThrow(
      new StructuredOutputSchemaError(
        'Structured output schema is not strict: $.value uses unsupported format future-format',
      ),
    );
  });

  it.each([
    'date-time',
    'time',
    'date',
    'duration',
    'email',
    'hostname',
    'ipv4',
    'ipv6',
    'uuid',
  ])('accepts the common raw string format %s', (format) => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot({ type: 'string', format }),
    )).not.toThrow();
  });

  it('rejects a non-string format value synchronously', () => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot({ type: 'string', format: true }),
    )).toThrow(
      new StructuredOutputSchemaError(
        'Structured output schema is not strict: $.value.format must be a string',
      ),
    );
  });

  it.each([
    {
      name: 'properties is not a plain object',
      valueSchema: {
        type: 'object',
        properties: [],
        required: [],
        additionalProperties: false,
      },
      expectedMessage: '$.value.properties must be a plain object',
    },
    {
      name: 'required is not an array',
      valueSchema: {
        type: 'object',
        properties: {},
        required: 'value',
        additionalProperties: false,
      },
      expectedMessage: '$.value.required must be an array',
    },
    {
      name: 'required contains a non-string entry',
      valueSchema: {
        type: 'object',
        properties: {},
        required: [1],
        additionalProperties: false,
      },
      expectedMessage: '$.value.required must contain only strings',
    },
  ])('rejects an object schema when $name', ({ valueSchema, expectedMessage }) => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot(valueSchema),
    )).toThrow(
      new StructuredOutputSchemaError(
        `Structured output schema is not strict: ${expectedMessage}`,
      ),
    );
  });

  it('accepts a strict object schema with plain properties and string required entries', () => {
    expect(() => assertStrictStructuredOutputSchema(createStrictRoot({
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    }))).not.toThrow();
  });

  it.each([
    ['an object enum member', { type: 'object', properties: {}, required: [], additionalProperties: false, enum: [{}] }],
    ['an array enum member', { type: 'array', items: { type: 'string' }, enum: [['ready']] }],
  ])('rejects %s', (_name, valueSchema) => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot(valueSchema),
    )).toThrow('enum must contain only lossless primitive JSON values');
  });

  it.each([
    ['positive infinity', { type: 'number', enum: [Number.POSITIVE_INFINITY] }],
    ['negative infinity', { type: 'number', enum: [Number.NEGATIVE_INFINITY] }],
    ['negative zero', { type: 'number', enum: [-0] }],
    ['undefined', { type: 'string', enum: [undefined] }],
    ['a bigint', { type: 'integer', enum: [1n] }],
    ['a symbol', { type: 'string', enum: [Symbol('value')] }],
    ['a function', { type: 'string', enum: [() => 'value'] }],
  ])('rejects %s', (_name, valueSchema) => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot(valueSchema),
    )).toThrow('schema must be a lossless JSON object');
  });

  it.each([
    ['string enum with number', { type: 'string', enum: [1] }],
    ['number enum with string', { type: 'number', enum: ['1'] }],
    ['integer enum with fraction', { type: 'integer', enum: [1.5] }],
    ['boolean enum with null', { type: 'boolean', enum: [null] }],
    ['nullable string enum with number', { type: ['string', 'null'], enum: [1] }],
  ])('rejects a declared type mismatch for %s', (_name, valueSchema) => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot(valueSchema),
    )).toThrow('enum value does not match its declared type');
  });

  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['negative zero', -0],
    ['a bigint', 1n],
    ['a symbol', Symbol('value')],
    ['a function', () => 'value'],
    ['a date', new Date('2026-01-01T00:00:00.000Z')],
    ['an array containing undefined', [undefined]],
    ['a sparse array', new Array(1)],
    ['an array with an extra property', Object.assign([1], { extra: true })],
    ['an object containing undefined', { value: undefined }],
    ['an object with a getter', Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 'value',
    })],
    ['an object with a symbol key', { [Symbol('value')]: 'value' }],
  ])('rejects a non-lossless JSON const: %s', (_name, value) => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot({ type: 'string', const: value }),
    )).toThrow('schema must be a lossless JSON object');
  });

  it('rejects a circular const value', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot({
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
        const: circular,
      }),
    )).toThrow('schema must be a lossless JSON object');
  });

  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['negative zero', -0],
    ['a bigint', 1n],
    ['a symbol', Symbol('description')],
    ['a function', () => 'description'],
  ])('rejects a schema containing a non-lossless description value: %s', (_name, description) => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot({ type: 'string', description }),
    )).toThrow('schema must be a lossless JSON object');
  });

  it('rejects a schema containing an enumerable getter', () => {
    const valueSchema = { type: 'string' };
    Object.defineProperty(valueSchema, 'description', {
      enumerable: true,
      get: () => 'description',
    });

    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot(valueSchema),
    )).toThrow('schema must be a lossless JSON object');
  });

  it.each([
    ['a sparse array', new Array(1)],
    ['an array with an extra property', Object.assign([{ type: 'string' }], { extra: true })],
  ])('rejects a schema containing %s', (_name, anyOf) => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot({ anyOf }),
    )).toThrow('schema must be a lossless JSON object');
  });

  it('rejects a schema containing a non-plain schema node', () => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot(new Date('2026-01-01T00:00:00.000Z')),
    )).toThrow('schema must be a lossless JSON object');
  });

  it('rejects a non-plain root schema object', () => {
    expect(() => assertStrictStructuredOutputSchema(
      new Date('2026-01-01T00:00:00.000Z') as unknown as Record<string, unknown>,
    )).toThrow('Structured output schema must be an object');
  });

  it('rejects a schema containing a symbol-keyed property', () => {
    const valueSchema = {
      type: 'string',
      [Symbol('description')]: 'description',
    };

    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot(valueSchema),
    )).toThrow('schema must be a lossless JSON object');
  });

  it('rejects a schema with a non-enumerable toJSON property', () => {
    const schema = createStrictRoot({ type: 'string' });
    Object.defineProperty(schema, 'toJSON', {
      value: () => ({ type: 'object' }),
    });

    expect(() => assertStrictStructuredOutputSchema(schema)).toThrow(
      'schema must be a lossless JSON object',
    );
  });

  it('rejects a schema whose properties graph is circular', () => {
    const schema = createStrictRoot({ type: 'string' });
    const properties = schema.properties as Record<string, unknown>;
    properties.circular = schema;

    expect(() => assertStrictStructuredOutputSchema(schema)).toThrow(
      'schema must be a lossless JSON object',
    );
  });

  it.each([
    ['string const with number', { type: 'string', const: 1 }],
    ['number const with string', { type: 'number', const: '1' }],
    ['integer const with fraction', { type: 'integer', const: 1.5 }],
    ['object const with string', {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
      const: 'value',
    }],
    ['array const with number', {
      type: 'array',
      items: { type: 'number' },
      const: 1,
    }],
    ['nullable string const with number', { type: ['string', 'null'], const: 1 }],
  ])('rejects a declared type mismatch for %s', (_name, valueSchema) => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot(valueSchema),
    )).toThrow('const value does not match its declared type');
  });

  it.each([
    ['type and anyOf', {
      type: 'string',
      anyOf: [
        { type: 'string' },
        { type: 'null' },
      ],
      const: 'fixed',
    }],
    ['type and $ref', {
      type: 'string',
      $ref: '#/$defs/value',
      $defs: {
        value: { type: 'string' },
      },
      enum: ['fixed'],
    }],
    ['anyOf and $ref', {
      anyOf: [
        { type: 'string' },
        { type: 'null' },
      ],
      $ref: '#/$defs/value',
      $defs: {
        value: { type: 'string' },
      },
    }],
  ])('rejects a schema node combining %s', (_name, valueSchema) => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot(valueSchema),
    )).toThrow('must declare exactly one of type, anyOf, or $ref');
  });

  it.each([
    ['enum on an anyOf wrapper', {
      anyOf: [
        { type: 'string' },
        { type: 'null' },
      ],
      enum: ['fixed'],
    }],
    ['const on a $ref wrapper', {
      $ref: '#/$defs/value',
      const: 'fixed',
      $defs: {
        value: { type: 'string' },
      },
    }],
  ])('rejects %s because the effective type is not local', (_name, valueSchema) => {
    expect(() => assertStrictStructuredOutputSchema(
      createStrictRoot(valueSchema),
    )).toThrow(/uses unsupported keyword (enum|const)/);
  });

  it.each([
    {
      name: 'string properties',
      schema: { type: 'string', properties: {} },
      keyword: 'properties',
    },
    {
      name: 'number items',
      schema: { type: 'number', items: { type: 'string' } },
      keyword: 'items',
    },
    {
      name: 'array required',
      schema: { type: 'array', items: { type: 'string' }, required: [] },
      keyword: 'required',
    },
    {
      name: 'object items',
      schema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
        items: { type: 'string' },
      },
      keyword: 'items',
    },
    {
      name: 'number pattern',
      schema: { type: 'number', pattern: '^x' },
      keyword: 'pattern',
    },
    {
      name: 'array format',
      schema: { type: 'array', items: { type: 'string' }, format: 'date' },
      keyword: 'format',
    },
  ])('rejects type-mismatched structural keyword: $name', ({ schema, keyword }) => {
    expectStrictSubsetRejection(
      createStrictRoot(schema),
      `$.value uses unsupported keyword ${keyword}`,
    );
  });

  it.each([
    {
      name: 'a direct self-reference',
      schema: {
        type: 'object',
        properties: {
          child: { $ref: '#' },
        },
        required: ['child'],
        additionalProperties: false,
      },
      expectedMessage: 'contains recursive $ref',
    },
    {
      name: 'mutually recursive definitions',
      schema: {
        type: 'object',
        properties: {
          value: { $ref: '#/$defs/first' },
        },
        required: ['value'],
        additionalProperties: false,
        $defs: {
          first: { $ref: '#/$defs/second' },
          second: { $ref: '#/$defs/first' },
        },
      },
      expectedMessage: 'contains recursive $ref',
    },
  ])('rejects $name', ({ schema, expectedMessage }) => {
    expect(() => assertStrictStructuredOutputSchema(schema)).toThrow(
      expectedMessage,
    );
  });
});
