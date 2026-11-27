import { describe, expect, it } from 'vitest';
import { notificationSilencePreload, withNotificationSilenceEnv } from '../../scripts/test-notification-silence.cjs';

describe('withNotificationSilenceEnv', () => {
  it('adds the preload to an explicit environment without changing its other values', () => {
    const env = { PATH: '/test/bin', NODE_OPTIONS: '--no-warnings --require="existing preload.cjs"' };
    const result = withNotificationSilenceEnv(env);

    expect(result.PATH).toBe('/test/bin');
    expect(result.NODE_OPTIONS).toContain(`--require=${JSON.stringify(notificationSilencePreload)}`);
    expect(result.NODE_OPTIONS).toContain(env.NODE_OPTIONS);
    expect(env.NODE_OPTIONS).toBe('--no-warnings --require="existing preload.cjs"');
  });

  it('keeps one preload when composed repeatedly', () => {
    const first = withNotificationSilenceEnv({});
    expect(withNotificationSilenceEnv(first)).toEqual(first);
    expect(first.NODE_OPTIONS).toBe(`--require=${JSON.stringify(notificationSilencePreload)}`);
  });
});
