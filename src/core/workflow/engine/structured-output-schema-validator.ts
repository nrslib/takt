import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

const ajv = new Ajv({
  allErrors: false,
  schemaId: 'auto',
  unknownFormats: 'ignore',
});

const validatorCache = new WeakMap<Record<string, unknown>, ValidateFunction>();

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

function formatValidationError(error: ErrorObject | null | undefined): string {
  if (!error) {
    return 'Structured output does not satisfy the schema';
  }

  const path = formatInstancePath(error);
  if (error.keyword === 'required') {
    return `${path} is required`;
  }
  if (error.keyword === 'additionalProperties') {
    return `${path} is not allowed by the schema`;
  }

  const message = error.message?.replace(/^should\b/, 'must');
  return message ? `${path} ${message}` : path;
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
    throw new Error(`Structured output schema is invalid: ${detail}`);
  }
}

export function validateStructuredOutputAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
): void {
  if (!isPlainObject(schema)) {
    throw new Error('Structured output schema must be an object');
  }

  const validate = getValidator(schema);
  if (validate(value)) {
    return;
  }

  throw new Error(formatValidationError(validate.errors?.[0]));
}
