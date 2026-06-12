import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildEnvWithNestedObservabilitySnapshot,
  getNestedObservabilityEnvFingerprint,
  pickCommandGateNestedObservabilityEnv,
  pickNestedObservabilityEnv,
  runWithNestedObservabilityProcessEnv,
} from '../shared/telemetry/index.js';

const TRACEPARENT = '00-11111111111111111111111111111111-1111111111111111-01';
const TRACESTATE = 'vendor=value';
const ENV_KEYS = [
  'TAKT_OBSERVABILITY',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'traceparent',
  'tracestate',
] as const;

let originalEnv: Map<string, string | undefined>;

function restoreEnv(previous: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('nested observability child process env', () => {
  beforeEach(() => {
    originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const));
  });

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it('Given trace context in childProcessEnv, When picking nested observability env, Then omits trace context', () => {
    const env = pickNestedObservabilityEnv({
      TAKT_OBSERVABILITY: '{"enabled":true}',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
      traceparent: TRACEPARENT,
      tracestate: TRACESTATE,
    });

    expect(env).toEqual({
      TAKT_OBSERVABILITY: '{"enabled":true}',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
    });
  });

  it('Given ambient and child trace context, When building child env snapshot, Then removes both trace contexts', () => {
    const env = buildEnvWithNestedObservabilitySnapshot({
      PATH: '/usr/bin',
      TAKT_OBSERVABILITY: '{"enabled":false}',
      traceparent: TRACEPARENT,
      tracestate: TRACESTATE,
    }, {
      TAKT_OBSERVABILITY: '{"enabled":true}',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
      traceparent: '00-22222222222222222222222222222222-2222222222222222-01',
      tracestate: 'other=value',
    });

    expect(env).toEqual({
      PATH: '/usr/bin',
      TAKT_OBSERVABILITY: '{"enabled":true}',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
    });
  });

  it('Given trace context in childProcessEnv, When applying process env temporarily, Then does not expose trace context', async () => {
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.traceparent = TRACEPARENT;
    process.env.tracestate = TRACESTATE;

    await runWithNestedObservabilityProcessEnv({
      TAKT_OBSERVABILITY: '{"enabled":true}',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
      traceparent: '00-22222222222222222222222222222222-2222222222222222-01',
      tracestate: 'other=value',
    }, async () => {
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":true}');
      expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://collector.example.test');
      expect(process.env.traceparent).toBeUndefined();
      expect(process.env.tracestate).toBeUndefined();
    });

    expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
    expect(process.env.traceparent).toBe(TRACEPARENT);
    expect(process.env.tracestate).toBe(TRACESTATE);
  });

  it('Given command gate childProcessEnv includes trace context, When filtering safe env, Then omits trace context', () => {
    const env = pickCommandGateNestedObservabilityEnv({
      TAKT_OBSERVABILITY: '{"enabled":true}',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
      traceparent: TRACEPARENT,
      tracestate: TRACESTATE,
    });

    expect(env).toEqual({
      TAKT_OBSERVABILITY: '{"enabled":true}',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
    });
  });

  it('Given trace context differs, When fingerprinting child env, Then fingerprint ignores trace context', () => {
    const first = getNestedObservabilityEnvFingerprint({
      TAKT_OBSERVABILITY: '{"enabled":true}',
      traceparent: TRACEPARENT,
    });
    const second = getNestedObservabilityEnvFingerprint({
      TAKT_OBSERVABILITY: '{"enabled":true}',
      traceparent: '00-22222222222222222222222222222222-2222222222222222-01',
    });

    expect(second).toBe(first);
  });
});
