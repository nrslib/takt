import { createHash } from 'node:crypto';
import {
  isOtlpEndpointEnvName,
  OTEL_EXPORTER_OTLP_ENDPOINT,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
} from './otlp.js';

const NESTED_OBSERVABILITY_ENV_KEYS = [
  'TAKT_OBSERVABILITY',
  'TAKT_OBSERVABILITY_ENABLED',
  'TAKT_OBSERVABILITY_MONITOR',
  'TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER',
  'TAKT_OBSERVABILITY_USAGE_EVENTS_PHASE',
  OTEL_EXPORTER_OTLP_ENDPOINT,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_TIMEOUT',
  'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT',
  'OTEL_EXPORTER_OTLP_METRICS_TIMEOUT',
  'OTEL_EXPORTER_OTLP_COMPRESSION',
  'OTEL_EXPORTER_OTLP_TRACES_COMPRESSION',
  'OTEL_EXPORTER_OTLP_METRICS_COMPRESSION',
  'OTEL_EXPORTER_OTLP_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE',
] as const;

type NestedObservabilityEnvKey = typeof NESTED_OBSERVABILITY_ENV_KEYS[number];

const NESTED_TRACE_CONTEXT_ENV_KEYS = ['traceparent', 'tracestate'] as const;
const NESTED_OBSERVABILITY_CLEANUP_ENV_KEYS = [
  ...NESTED_OBSERVABILITY_ENV_KEYS,
  ...NESTED_TRACE_CONTEXT_ENV_KEYS,
] as const;
const NESTED_OBSERVABILITY_CLEANUP_ENV_KEY_SET = new Set<string>(NESTED_OBSERVABILITY_CLEANUP_ENV_KEYS);
const COMMAND_GATE_OTLP_ENDPOINT_PROTOCOLS = new Set(['http:', 'https:']);

function isNestedObservabilityCleanupEnvKey(key: string): boolean {
  return NESTED_OBSERVABILITY_CLEANUP_ENV_KEY_SET.has(key);
}

function pickStaticNestedObservabilityEnv(
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (!childProcessEnv) {
    return env;
  }

  for (const key of NESTED_OBSERVABILITY_ENV_KEYS) {
    const value = childProcessEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export function pickNestedObservabilityEnv(
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  if (!childProcessEnv) {
    return {};
  }

  return pickStaticNestedObservabilityEnv(childProcessEnv);
}

function isCommandGateSafeNestedObservabilityEnvEntry(
  key: NestedObservabilityEnvKey,
  value: string,
): boolean {
  if (key.endsWith('_HEADERS')
    || key.endsWith('_CLIENT_CERTIFICATE')
    || key.endsWith('_CLIENT_KEY')) {
    return false;
  }
  if (!isOtlpEndpointEnvName(key)) {
    return true;
  }
  return isCommandGateSafeOtlpEndpoint(value);
}

function isCommandGateSafeOtlpEndpoint(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return COMMAND_GATE_OTLP_ENDPOINT_PROTOCOLS.has(parsed.protocol)
    && !parsed.username
    && !parsed.password
    && !parsed.search
    && !parsed.hash;
}

function isNestedOtelExporterOptionKey(key: NestedObservabilityEnvKey): boolean {
  return key.startsWith('OTEL_EXPORTER_OTLP_')
    && !isOtlpEndpointEnvName(key);
}

export function pickCommandGateNestedObservabilityEnv(
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (!childProcessEnv) {
    return env;
  }

  for (const key of NESTED_OBSERVABILITY_ENV_KEYS) {
    const value = childProcessEnv[key];
    if (value === undefined || !isCommandGateSafeNestedObservabilityEnvEntry(key, value)) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

export function pickNestedOtelExporterOptionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const otelEnv: NodeJS.ProcessEnv = {};
  for (const key of NESTED_OBSERVABILITY_ENV_KEYS) {
    if (!isNestedOtelExporterOptionKey(key)) {
      continue;
    }
    const value = env[key];
    if (value !== undefined) {
      otelEnv[key] = value;
    }
  }
  return otelEnv;
}

export function buildEnvWithNestedObservabilitySnapshot(
  source: NodeJS.ProcessEnv,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  if (!childProcessEnv) {
    return { ...source };
  }

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !isNestedObservabilityCleanupEnvKey(key)) {
      env[key] = value;
    }
  }
  return {
    ...env,
    ...pickNestedObservabilityEnv(childProcessEnv),
  };
}

export function getNestedObservabilityEnvFingerprint(
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): string {
  const env = pickNestedObservabilityEnv(childProcessEnv);
  const normalized = JSON.stringify(NESTED_OBSERVABILITY_ENV_KEYS
    .map((key) => [key, env[key]])
    .filter(([, value]) => value !== undefined));
  return createHash('sha256').update(normalized).digest('hex');
}

let nestedProcessEnvMutation: Promise<void> = Promise.resolve();

export async function runWithNestedObservabilityProcessEnv<T>(
  childProcessEnv: Readonly<Record<string, string>> | undefined,
  operation: () => T | Promise<T>,
): Promise<Awaited<T>> {
  const previousMutation = nestedProcessEnvMutation;
  let releaseMutation!: () => void;
  nestedProcessEnvMutation = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });

  await previousMutation;

  if (!childProcessEnv) {
    try {
      return await operation();
    } finally {
      releaseMutation();
    }
  }

  const nextEnv = pickNestedObservabilityEnv(childProcessEnv);
  const previousEnv = new Map(
    NESTED_OBSERVABILITY_CLEANUP_ENV_KEYS.map((key) => [key, process.env[key]] as const),
  );

  try {
    for (const key of NESTED_OBSERVABILITY_CLEANUP_ENV_KEYS) {
      delete process.env[key];
    }
    Object.assign(process.env, nextEnv);
    return await operation();
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    releaseMutation();
  }
}
