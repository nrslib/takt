import { describe, expect, it } from 'vitest';
import {
  buildEnvWithNestedObservabilitySnapshot,
  getNestedObservabilityEnvFingerprint,
  observabilitySnapshotOf,
  pickCommandGateNestedObservabilityEnv,
  pickNestedObservabilityEnv,
} from '../shared/telemetry/index.js';

const TRACEPARENT = '00-11111111111111111111111111111111-1111111111111111-01';
const TRACESTATE = 'vendor=value';
describe('nested observability child process env', () => {
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

  it('Given repository identity in childProcessEnv, When picking nested env, Then keeps it for providers and command gates', () => {
    const childProcessEnv = { GH_REPO: 'owner/repo', GITLAB_REPO: 'https://gitlab.example.com/a/b/c' };

    expect(pickNestedObservabilityEnv(childProcessEnv)).toEqual(childProcessEnv);
    expect(pickCommandGateNestedObservabilityEnv(childProcessEnv)).toEqual(childProcessEnv);
  });

  it('Given only repository identity, When asked for the observability snapshot, Then it is none', () => {
    expect(observabilitySnapshotOf({ GH_REPO: 'owner/repo' })).toBeUndefined();
    expect(observabilitySnapshotOf(undefined)).toBeUndefined();
  });

  it('Given observability settings (with or without identity), When asked for the snapshot, Then it is the snapshot', () => {
    const withObservability = { TAKT_OBSERVABILITY: '{}', GH_REPO: 'owner/repo' };

    expect(observabilitySnapshotOf(withObservability)).toBe(withObservability);
    expect(observabilitySnapshotOf({})).toEqual({});
  });

  it('Given only repository identity, When building child env snapshot, Then keeps ambient observability env', () => {
    const env = buildEnvWithNestedObservabilitySnapshot({
      PATH: '/usr/bin',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ambient.example.test',
      traceparent: TRACEPARENT,
    }, { GH_REPO: 'owner/repo' });

    expect(env).toEqual({
      PATH: '/usr/bin',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ambient.example.test',
      traceparent: TRACEPARENT,
      GH_REPO: 'owner/repo',
    });
  });

  it('Given repository identity differs, When fingerprinting child env, Then fingerprint differs', () => {
    expect(getNestedObservabilityEnvFingerprint({ GH_REPO: 'owner/one' }))
      .not.toBe(getNestedObservabilityEnvFingerprint({ GH_REPO: 'owner/two' }));
  });

});
