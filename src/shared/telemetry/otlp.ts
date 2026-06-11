export const OTEL_EXPORTER_OTLP_ENDPOINT = 'OTEL_EXPORTER_OTLP_ENDPOINT';
export const OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT';
export const OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT';

export type OtlpEndpointEnvName =
  | typeof OTEL_EXPORTER_OTLP_ENDPOINT
  | typeof OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  | typeof OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;

export type OtlpExporterDisabledReason = 'observability-disabled' | 'endpoint-unset';

export type OtlpExporterEndpointSource =
  | { kind: 'env'; name: OtlpEndpointEnvName }
  | { kind: 'derived'; from: typeof OTEL_EXPORTER_OTLP_ENDPOINT };

export type OtlpSignalExporterConfig = {
  endpoint: string;
  source: OtlpExporterEndpointSource;
};

export type EnabledOtlpExporterConfig = {
  enabled: true;
  endpoint: string;
  endpointSource: { kind: 'env'; name: typeof OTEL_EXPORTER_OTLP_ENDPOINT };
  traces: OtlpSignalExporterConfig;
  metrics: OtlpSignalExporterConfig;
};

export type DisabledOtlpExporterConfig = {
  enabled: false;
  reason: OtlpExporterDisabledReason;
};

export type OtlpExporterConfig = EnabledOtlpExporterConfig | DisabledOtlpExporterConfig;

export type OtlpExporterConfigInput = {
  observabilityEnabled: boolean;
  env: OtlpEnvironment;
};

export type OtlpEnvironment = Record<string, string | undefined>;

const OTLP_HTTP_PROTOCOLS = new Set(['http:', 'https:']);
export function resolveOtlpExporterConfigFromEnv(observabilityEnabled: boolean): OtlpExporterConfig {
  return resolveOtlpExporterConfig({ observabilityEnabled, env: process.env });
}

export function resolveOtlpExporterConfig(input: OtlpExporterConfigInput): OtlpExporterConfig {
  if (!input.observabilityEnabled) {
    return { enabled: false, reason: 'observability-disabled' };
  }

  const endpoint = readTrimmedEnv(input.env, OTEL_EXPORTER_OTLP_ENDPOINT);
  if (endpoint === undefined) {
    return { enabled: false, reason: 'endpoint-unset' };
  }

  assertHttpEndpoint(OTEL_EXPORTER_OTLP_ENDPOINT, endpoint);
  return {
    enabled: true,
    endpoint,
    endpointSource: { kind: 'env', name: OTEL_EXPORTER_OTLP_ENDPOINT },
    traces: resolveSignalEndpoint(
      input.env,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      endpoint,
      'v1/traces',
    ),
    metrics: resolveSignalEndpoint(
      input.env,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
      endpoint,
      'v1/metrics',
    ),
  };
}

function resolveSignalEndpoint(
  env: OtlpEnvironment,
  envName: OtlpEndpointEnvName,
  baseEndpoint: string,
  signalPath: string,
): OtlpSignalExporterConfig {
  const endpoint = readTrimmedEnv(env, envName);
  if (endpoint !== undefined) {
    assertHttpEndpoint(envName, endpoint);
    return {
      endpoint,
      source: { kind: 'env', name: envName },
    };
  }

  return {
    endpoint: appendPath(baseEndpoint, signalPath),
    source: { kind: 'derived', from: OTEL_EXPORTER_OTLP_ENDPOINT },
  };
}

function readTrimmedEnv(env: OtlpEnvironment, name: OtlpEndpointEnvName): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function assertHttpEndpoint(envName: OtlpEndpointEnvName, endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`${envName} must be an absolute HTTP(S) URL`);
  }

  if (!OTLP_HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`${envName} must use http or https`);
  }
}

function appendPath(endpoint: string, path: string): string {
  const normalizedEndpoint = endpoint.endsWith('/') ? endpoint : `${endpoint}/`;
  return new URL(path, normalizedEndpoint).toString();
}
