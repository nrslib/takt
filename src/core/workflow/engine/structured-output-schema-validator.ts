import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

const ajv = new Ajv({
  allErrors: true,
  schemaId: 'auto',
  unknownFormats: 'ignore',
});

const validatorCache = new WeakMap<Record<string, unknown>, ValidateFunction>();

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
  return typeof value === 'object' && value != null && !Array.isArray(value);
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

export function assertStructuredOutputSchema(schema: Record<string, unknown>): void {
  if (!isPlainObject(schema)) {
    throw new StructuredOutputSchemaError('Structured output schema must be an object');
  }

  getValidator(schema);
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
