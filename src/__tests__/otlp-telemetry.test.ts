import { describe, expect, it } from 'vitest';
import {
  OTEL_EXPORTER_OTLP_ENDPOINT,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  resolveOtlpExporterConfig,
  type OtlpEnvironment,
} from '../shared/telemetry/index.js';

function resolve(observabilityEnabled: boolean, env: OtlpEnvironment) {
  return resolveOtlpExporterConfig({ observabilityEnabled, env });
}

describe('OTLP exporter config resolution', () => {
  it('disables OTLP when observability is disabled even if endpoint is set', () => {
    expect(resolve(false, {
      [OTEL_EXPORTER_OTLP_ENDPOINT]: 'http://127.0.0.1:4318',
    })).toEqual({
      enabled: false,
      reason: 'observability-disabled',
    });
  });

  it('disables OTLP when the required base endpoint is unset', () => {
    expect(resolve(true, {})).toEqual({
      enabled: false,
      reason: 'endpoint-unset',
    });
  });

  it('treats blank endpoint values as unset', () => {
    expect(resolve(true, {
      [OTEL_EXPORTER_OTLP_ENDPOINT]: '   ',
    })).toEqual({
      enabled: false,
      reason: 'endpoint-unset',
    });
  });

  it('resolves trace and metric endpoints from the base endpoint', () => {
    expect(resolve(true, {
      [OTEL_EXPORTER_OTLP_ENDPOINT]: ' http://127.0.0.1:4318 ',
    })).toEqual({
      enabled: true,
      endpoint: 'http://127.0.0.1:4318',
      endpointSource: { kind: 'env', name: OTEL_EXPORTER_OTLP_ENDPOINT },
      traces: {
        endpoint: 'http://127.0.0.1:4318/v1/traces',
        source: { kind: 'derived', from: OTEL_EXPORTER_OTLP_ENDPOINT },
      },
      metrics: {
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        source: { kind: 'derived', from: OTEL_EXPORTER_OTLP_ENDPOINT },
      },
    });
  });

  it('uses signal-specific endpoints when they are explicitly set', () => {
    expect(resolve(true, {
      [OTEL_EXPORTER_OTLP_ENDPOINT]: 'https://collector.example.test',
      [OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: 'https://collector.example.test/custom/traces',
      [OTEL_EXPORTER_OTLP_METRICS_ENDPOINT]: 'https://collector.example.test/custom/metrics',
    })).toEqual({
      enabled: true,
      endpoint: 'https://collector.example.test',
      endpointSource: { kind: 'env', name: OTEL_EXPORTER_OTLP_ENDPOINT },
      traces: {
        endpoint: 'https://collector.example.test/custom/traces',
        source: { kind: 'env', name: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT },
      },
      metrics: {
        endpoint: 'https://collector.example.test/custom/metrics',
        source: { kind: 'env', name: OTEL_EXPORTER_OTLP_METRICS_ENDPOINT },
      },
    });
  });

  it('disables OTLP when only signal-specific endpoints are configured without the base endpoint', () => {
    expect(resolve(true, {
      [OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]: 'http://127.0.0.1:4318/v1/traces',
      [OTEL_EXPORTER_OTLP_METRICS_ENDPOINT]: 'http://127.0.0.1:4318/v1/metrics',
    })).toEqual({
      enabled: false,
      reason: 'endpoint-unset',
    });
  });

  it('rejects non-HTTP base endpoints', () => {
    expect(() => resolve(true, {
      [OTEL_EXPORTER_OTLP_ENDPOINT]: 'grpc://127.0.0.1:4317',
    })).toThrow(`${OTEL_EXPORTER_OTLP_ENDPOINT} must use http or https`);
  });

  it('rejects invalid signal-specific endpoint URLs', () => {
    expect(() => resolve(true, {
      [OTEL_EXPORTER_OTLP_ENDPOINT]: 'http://127.0.0.1:4318',
      [OTEL_EXPORTER_OTLP_METRICS_ENDPOINT]: 'not-a-url',
    })).toThrow(`${OTEL_EXPORTER_OTLP_METRICS_ENDPOINT} must be an absolute HTTP(S) URL`);
  });
});
