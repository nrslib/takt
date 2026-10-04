import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeDeepSeekCredentialHomeOrigin,
  resolveDeepSeekCredentialHome,
  type ResolveDeepSeekCredentialHomeOptions,
} from '../infra/deepseek-harness/credential-home.js';

const USER_HOME = path.join(tmpdir(), 'takt-deepseek-credential-user-home');
const CHILD_HOME = path.join(tmpdir(), 'takt-deepseek-credential-child-home');
const AMBIENT_HOME = path.join(tmpdir(), 'takt-deepseek-credential-ambient-home');

function resolveOptions(
  overrides: Partial<ResolveDeepSeekCredentialHomeOptions> = {},
): ResolveDeepSeekCredentialHomeOptions {
  return {
    childProcessEnv: undefined,
    ambientEnv: {},
    userHome: USER_HOME,
    ...overrides,
  };
}

function captureHomeError(options: ResolveDeepSeekCredentialHomeOptions): string {
  try {
    resolveDeepSeekCredentialHome(options);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('DeepSeek credential source home was accepted unexpectedly');
}

describe('DeepSeek Harness credential source home', () => {
  it('resolves the home and both credential paths from the child process environment first', () => {
    const home = resolveDeepSeekCredentialHome(resolveOptions({
      childProcessEnv: { DSH_HOME: CHILD_HOME },
      ambientEnv: { DSH_HOME: AMBIENT_HOME },
    }));

    expect(home.origin).toBe('child-process-env');
    expect(home.homePath).toBe(CHILD_HOME);
    expect(home.credentialsPath).toBe(path.join(CHILD_HOME, '.credentials.yaml'));
    expect(home.settingsPath).toBe(path.join(CHILD_HOME, 'settings.yaml'));
  });

  it('falls back to the ambient environment when the child process environment omits DSH_HOME', () => {
    const home = resolveDeepSeekCredentialHome(resolveOptions({
      childProcessEnv: { PATH: '/usr/bin' },
      ambientEnv: { DSH_HOME: AMBIENT_HOME },
    }));

    expect(home.origin).toBe('environment');
    expect(home.homePath).toBe(AMBIENT_HOME);
    expect(home.credentialsPath).toBe(path.join(AMBIENT_HOME, '.credentials.yaml'));
  });

  it('falls back to the default harness home under the OS user home', () => {
    const home = resolveDeepSeekCredentialHome(resolveOptions());

    expect(home.origin).toBe('default');
    expect(home.homePath).toBe(path.join(USER_HOME, '.dsh'));
    expect(home.credentialsPath).toBe(path.join(USER_HOME, '.dsh', '.credentials.yaml'));
    expect(home.settingsPath).toBe(path.join(USER_HOME, '.dsh', 'settings.yaml'));
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['relative/dsh', 'relative'],
    ['~/dsh', 'tilde'],
    ['$DSH_HOME', 'unexpanded variable'],
  ] as const)('rejects an explicit DSH_HOME that is %s (%s) instead of falling back', (value, _label) => {
    const message = captureHomeError(resolveOptions({
      childProcessEnv: { DSH_HOME: value },
      ambientEnv: { DSH_HOME: AMBIENT_HOME },
    }));

    expect(message).toContain('DSH_HOME');
    expect(message).toMatch(/absolute/iu);
  });

  it.each([
    ['NUL', `unsafe${String.fromCharCode(0)}home`],
    ['line feed', `unsafe${String.fromCharCode(10)}home`],
    ['escape', `unsafe${String.fromCharCode(27)}home`],
  ] as const)('rejects an explicit DSH_HOME that contains a %s control character', (_label, name) => {
    const message = captureHomeError(resolveOptions({
      childProcessEnv: { DSH_HOME: path.join(tmpdir(), name) },
    }));

    expect(message).toContain('DSH_HOME');
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  });

  it('rejects an invalid ambient DSH_HOME without falling back to the default home', () => {
    const message = captureHomeError(resolveOptions({
      ambientEnv: { DSH_HOME: 'relative/dsh' },
    }));

    expect(message).toContain('DSH_HOME');
    expect(message).toMatch(/absolute/iu);
  });

  it.each([
    ['child-process-env', 'DSH_HOME'],
    ['environment', 'DSH_HOME'],
    ['default', '~/.dsh'],
  ] as const)('describes the %s origin by name instead of by path', (origin, expectedText) => {
    expect(describeDeepSeekCredentialHomeOrigin(origin)).toContain(expectedText);
  });
});
