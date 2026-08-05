import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

const ajv = new Ajv({
  allErrors: true,
  schemaId: 'auto',
  unknownFormats: 'ignore',
});

const validatorCache = new WeakMap<Record<string, unknown>, ValidateFunction>();

type StrictSchemaType = 'string' | 'number' | 'boolean' | 'integer' | 'object' | 'array' | 'null';

const TYPED_RAW_STRUCTURED_OUTPUT_KEYWORDS = [
  '$defs',
  'type',
  'description',
  'enum',
  'const',
] as const;

const RAW_STRUCTURED_OUTPUT_KEYWORDS_BY_TYPE: Record<StrictSchemaType, readonly string[]> = {
  string: ['format'],
  number: [],
  boolean: [],
  integer: [],
  object: ['properties', 'required', 'additionalProperties'],
  array: ['items', 'maxItems'],
  null: [],
};

const SUPPORTED_RAW_STRING_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uuid',
]);

const STRICT_SCHEMA_TYPES = new Set<StrictSchemaType>(
  Object.keys(RAW_STRUCTURED_OUTPUT_KEYWORDS_BY_TYPE) as StrictSchemaType[],
);

export class StructuredOutputSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuredOutputSchemaError';
  }
}

export class StructuredOutputValueValidationError extends Error {
  constructor(
    readonly issues: readonly StructuredOutputValueValidationIssue[],
  ) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'StructuredOutputValueValidationError';
  }
}

export interface StructuredOutputValueValidationIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function formatPathSegment(segment: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
    ? `.${segment}`
    : `[${JSON.stringify(segment)}]`;
}

function formatInstancePath(error: ErrorObject): string {
  const basePath = error.dataPath === '' ? '$' : `$${error.dataPath}`;

  if (error.keyword === 'required') {
    const missingProperty = (error.params as { missingProperty?: unknown }).missingProperty;
    if (typeof missingProperty === 'string') {
      return `${basePath}${formatPathSegment(missingProperty)}`;
    }
  }

  if (error.keyword === 'additionalProperties') {
    const additionalProperty = (error.params as { additionalProperty?: unknown }).additionalProperty;
    if (typeof additionalProperty === 'string') {
      return `${basePath}${formatPathSegment(additionalProperty)}`;
    }
  }

  return basePath;
}

function formatValidationError(error: ErrorObject | null | undefined): StructuredOutputValueValidationIssue {
  if (!error) {
    return {
      path: '$',
      keyword: 'schema',
      message: 'Structured output does not satisfy the schema',
    };
  }

  const path = formatInstancePath(error);
  if (error.keyword === 'required') {
    return { path, keyword: error.keyword, message: `${path} is required` };
  }
  if (error.keyword === 'additionalProperties') {
    return {
      path,
      keyword: error.keyword,
      message: `${path} is not allowed by the schema`,
    };
  }

  const message = error.message?.replace(/^should\b/, 'must');
  return {
    path,
    keyword: error.keyword,
    message: message ? `${path} ${message}` : path,
  };
}

function getValidator(schema: Record<string, unknown>): ValidateFunction {
  const cached = validatorCache.get(schema);
  if (cached) {
    return cached;
  }

  try {
    const validate = ajv.compile(schema);
    validatorCache.set(schema, validate);
    return validate;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new StructuredOutputSchemaError(`Structured output schema is invalid: ${detail}`);
  }
}

function strictSchemaError(message: string): StructuredOutputSchemaError {
  return new StructuredOutputSchemaError(
    `Structured output schema is not strict: ${message}`,
  );
}

function getStrictSchemaTypes(
  schema: Record<string, unknown>,
  path: string,
): readonly StrictSchemaType[] | undefined {
  const schemaForms = [schema.type, schema.anyOf, schema.$ref]
    .filter((value) => value !== undefined);
  if (schemaForms.length === 0) {
    throw strictSchemaError(
      `${path} must declare type, anyOf, or $ref`,
    );
  }
  if (schemaForms.length !== 1) {
    throw strictSchemaError(
      `${path} must declare exactly one of type, anyOf, or $ref`,
    );
  }
  if (schema.type === undefined) {
    return undefined;
  }

  if (typeof schema.type === 'string' && STRICT_SCHEMA_TYPES.has(schema.type as StrictSchemaType)) {
    return [schema.type as StrictSchemaType];
  }

  if (Array.isArray(schema.type) && schema.type.length === 2) {
    const nonNullTypes = schema.type.filter((type) => type !== 'null');
    if (
      schema.type.includes('null')
      && nonNullTypes.length === 1
      && typeof nonNullTypes[0] === 'string'
      && STRICT_SCHEMA_TYPES.has(nonNullTypes[0] as StrictSchemaType)
    ) {
      return [nonNullTypes[0] as StrictSchemaType, 'null'];
    }
  }

  throw strictSchemaError(
    `${path}.type must be a supported type or nullable type union`,
  );
}

function assertSupportedStrictSchemaKeywords(
  schema: Record<string, unknown>,
  schemaTypes: readonly StrictSchemaType[] | undefined,
  path: string,
): void {
  const supportedKeywords = schemaTypes === undefined
    ? new Set<string>(
      schema.anyOf !== undefined
        ? ['anyOf', 'description']
        : ['$ref', 'description'],
    )
    : new Set<string>(TYPED_RAW_STRUCTURED_OUTPUT_KEYWORDS);
  if (schemaTypes !== undefined) {
    for (const schemaType of schemaTypes) {
      for (const keyword of RAW_STRUCTURED_OUTPUT_KEYWORDS_BY_TYPE[schemaType]) {
        supportedKeywords.add(keyword);
      }
    }
  }

  for (const keyword of Object.keys(schema)) {
    if (!supportedKeywords.has(keyword)) {
      throw strictSchemaError(
        `${path} uses unsupported keyword ${keyword}`,
      );
    }
  }

  if (schemaTypes?.includes('string') && Object.hasOwn(schema, 'format')) {
    if (typeof schema.format !== 'string') {
      throw strictSchemaError(`${path}.format must be a string`);
    }
    if (!SUPPORTED_RAW_STRING_FORMATS.has(schema.format)) {
      throw strictSchemaError(`${path} uses unsupported format ${schema.format}`);
    }
  }
}

function isLosslessPrimitiveJsonValue(value: unknown): boolean {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (
      typeof value === 'number'
      && Number.isFinite(value)
      && !Object.is(value, -0)
    );
}

function isLosslessJsonValue(
  value: unknown,
  ancestors: ReadonlySet<object> = new Set(),
): boolean {
  if (isLosslessPrimitiveJsonValue(value)) {
    return true;
  }
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    return false;
  }

  const nextAncestors = new Set([...ancestors, value]);
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) {
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor?.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
        || !isLosslessJsonValue(descriptor.value, nextAncestors)
      ) {
        return false;
      }
    }
    return true;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true
      && Object.hasOwn(descriptor, 'value')
      && isLosslessJsonValue(descriptor.value, nextAncestors);
  });
}

function valueMatchesSchemaTypes(
  value: unknown,
  schemaTypes: readonly StrictSchemaType[],
): boolean {
  return schemaTypes.some((schemaType) => {
    switch (schemaType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'object':
        return isPlainObject(value);
      case 'array':
        return Array.isArray(value);
      case 'null':
        return value === null;
    }
  });
}

function assertTypedValueKeywords(
  schema: Record<string, unknown>,
  schemaTypes: readonly StrictSchemaType[],
  path: string,
): void {
  if (Object.hasOwn(schema, 'enum')) {
    if (
      !Array.isArray(schema.enum)
      || !schema.enum.every(isLosslessPrimitiveJsonValue)
    ) {
      throw strictSchemaError(
        `${path}.enum must contain only lossless primitive JSON values`,
      );
    }
    if (!schema.enum.every((value) => valueMatchesSchemaTypes(value, schemaTypes))) {
      throw strictSchemaError(
        `${path}.enum value does not match its declared type`,
      );
    }
  }

  if (Object.hasOwn(schema, 'const')) {
    if (!isLosslessPrimitiveJsonValue(schema.const)) {
      throw strictSchemaError(
        `${path}.const must be a lossless primitive JSON value`,
      );
    }
    if (!valueMatchesSchemaTypes(schema.const, schemaTypes)) {
      throw strictSchemaError(
        `${path}.const value does not match its declared type`,
      );
    }
  }
}

function assertStrictObjectSchema(
  schema: Record<string, unknown>,
  path: string,
): void {
  const properties = schema.properties;
  if (!isPlainObject(properties)) {
    throw strictSchemaError(`${path}.properties must be a plain object`);
  }

  const requiredProperties = schema.required;
  if (!Array.isArray(requiredProperties)) {
    throw strictSchemaError(`${path}.required must be an array`);
  }
  if (!requiredProperties.every((property): property is string => typeof property === 'string')) {
    throw strictSchemaError(`${path}.required must contain only strings`);
  }

  if (schema.additionalProperties !== false) {
    throw strictSchemaError(
      `${path} must set additionalProperties to false`,
    );
  }

  const required = new Set(requiredProperties);
  const missingProperties = Object.keys(properties).filter((property) => !required.has(property));
  if (missingProperties.length > 0) {
    throw strictSchemaError(
      `${path} must list every property in required (missing: ${missingProperties.join(', ')})`,
    );
  }
  const unknownProperties = requiredProperties.filter(
    (property) => !Object.hasOwn(properties, property),
  );
  if (unknownProperties.length > 0) {
    throw strictSchemaError(
      `${path} must only require declared properties (unknown: ${unknownProperties.join(', ')})`,
    );
  }
}

function getNestedSubschemas(
  schema: Record<string, unknown>,
  path: string,
): Array<{ schema: unknown; path: string }> {
  const nested: Array<{ schema: unknown; path: string }> = [];
  if (isPlainObject(schema.properties)) {
    for (const [property, propertySchema] of Object.entries(schema.properties)) {
      nested.push({
        schema: propertySchema,
        path: `${path}${formatPathSegment(property)}`,
      });
    }
  }
  if (schema.items !== undefined) {
    nested.push({ schema: schema.items, path: `${path}.items` });
  }
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((alternative, index) => {
      nested.push({ schema: alternative, path: `${path}.anyOf[${index}]` });
    });
  }
  if (isPlainObject(schema.$defs)) {
    for (const [name, definition] of Object.entries(schema.$defs)) {
      nested.push({
        schema: definition,
        path: `${path}.$defs${formatPathSegment(name)}`,
      });
    }
  }
  return nested;
}

function assertStrictSubschema(
  schema: unknown,
  path: string,
): void {
  if (!isPlainObject(schema)) {
    throw strictSchemaError(`${path} must be a schema object`);
  }

  const schemaTypes = getStrictSchemaTypes(schema, path);
  assertSupportedStrictSchemaKeywords(schema, schemaTypes, path);
  if (schemaTypes !== undefined) {
    assertTypedValueKeywords(schema, schemaTypes, path);
  }
  if (schemaTypes?.includes('object')) {
    assertStrictObjectSchema(schema, path);
  }

  const definitions = schema.$defs;
  if (definitions !== undefined && !isPlainObject(definitions)) {
    throw strictSchemaError(
      `${path}.$defs must be a schema object map`,
    );
  }

  for (const nested of getNestedSubschemas(schema, path)) {
    assertStrictSubschema(nested.schema, nested.path);
  }
}

function resolveLocalSchemaRef(
  rootSchema: Record<string, unknown>,
  ref: string,
  path: string,
): Record<string, unknown> {
  if (ref !== '#' && !ref.startsWith('#/')) {
    throw strictSchemaError(`${path} uses unsupported non-local $ref ${ref}`);
  }

  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    throw strictSchemaError(`${path} uses invalid $ref ${ref}`);
  }

  let target: unknown = rootSchema;
  for (const encodedSegment of pointer.split('/').slice(1)) {
    const segment = encodedSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isPlainObject(target) || !Object.hasOwn(target, segment)) {
      throw strictSchemaError(`${path} uses unresolved $ref ${ref}`);
    }
    target = target[segment];
  }

  if (!isPlainObject(target)) {
    throw strictSchemaError(`${path} $ref ${ref} must resolve to a schema object`);
  }
  return target;
}

function assertNoRecursiveRefs(rootSchema: Record<string, unknown>): void {
  const visit = (
    schema: Record<string, unknown>,
    path: string,
    activeSchemas: ReadonlySet<Record<string, unknown>>,
  ): void => {
    if (typeof schema.$ref === 'string') {
      const target = resolveLocalSchemaRef(rootSchema, schema.$ref, path);
      if (activeSchemas.has(target)) {
        throw strictSchemaError(
          `${path} contains recursive $ref ${schema.$ref}`,
        );
      }
      visit(target, path, new Set([...activeSchemas, target]));
    }

    for (const nested of getNestedSubschemas(schema, path)) {
      if (isPlainObject(nested.schema)) {
        visit(
          nested.schema,
          nested.path,
          new Set([...activeSchemas, nested.schema]),
        );
      }
    }
  };

  visit(rootSchema, '$', new Set([rootSchema]));
}

function assertStrictRootSchema(schema: Record<string, unknown>): void {
  if (schema.type !== 'object') {
    throw strictSchemaError('$ must have type object');
  }
  if (schema.anyOf !== undefined) {
    throw strictSchemaError('$ must not use anyOf');
  }
}

export function assertStructuredOutputSchema(schema: Record<string, unknown>): void {
  if (!isPlainObject(schema)) {
    throw new StructuredOutputSchemaError('Structured output schema must be an object');
  }

  getValidator(schema);
}

export function assertStrictStructuredOutputSchema(schema: Record<string, unknown>): void {
  if (!isPlainObject(schema)) {
    throw new StructuredOutputSchemaError('Structured output schema must be an object');
  }
  if (!isLosslessJsonValue(schema)) {
    throw new StructuredOutputSchemaError(
      'Structured output schema must be a lossless JSON object',
    );
  }
  assertStrictRootSchema(schema);
  assertStrictSubschema(schema, '$');
  assertNoRecursiveRefs(schema);
  assertStructuredOutputSchema(schema);
}

export function validateStructuredOutputAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
): void {
  assertStructuredOutputSchema(schema);
  const validate = getValidator(schema);
  if (validate(value)) {
    return;
  }

  throw new StructuredOutputValueValidationError(
    (validate.errors ?? [undefined]).map(formatValidationError),
  );
}
