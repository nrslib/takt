import * as path from 'node:path';

const DSH_HOME_ENVIRONMENT_NAME = 'DSH_HOME';
const DEFAULT_HARNESS_HOME_DIRECTORY = '.dsh';
const CREDENTIALS_FILE_NAME = '.credentials.yaml';
const SETTINGS_FILE_NAME = 'settings.yaml';
// eslint-disable-next-line no-control-regex -- reject C0/C1 control characters in an explicit DSH_HOME
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const INVALID_EXPLICIT_HOME_MESSAGE = 'DeepSeek Harness DSH_HOME must be an absolute path '
  + 'without shell expansion; unset DSH_HOME to use the default ~/.dsh harness home';
const CONTROL_CHARACTER_HOME_MESSAGE = 'DeepSeek Harness DSH_HOME contains control characters '
  + 'and cannot be used as the credential source home';

export type DeepSeekCredentialHomeOrigin = 'child-process-env' | 'environment' | 'default';

export interface ResolveDeepSeekCredentialHomeOptions {
  childProcessEnv?: Readonly<Record<string, string>> | undefined;
  ambientEnv: Readonly<Record<string, string | undefined>>;
  userHome: string;
}

export interface DeepSeekCredentialSourceHome {
  origin: DeepSeekCredentialHomeOrigin;
  homePath: string;
  credentialsPath: string;
  settingsPath: string;
}

function selectExplicitHome(value: string): string {
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error(CONTROL_CHARACTER_HOME_MESSAGE);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed !== value || !path.isAbsolute(trimmed)) {
    throw new Error(INVALID_EXPLICIT_HOME_MESSAGE);
  }
  return path.resolve(trimmed);
}

function createSourceHome(origin: DeepSeekCredentialHomeOrigin, homePath: string): DeepSeekCredentialSourceHome {
  return {
    origin,
    homePath,
    credentialsPath: path.join(homePath, CREDENTIALS_FILE_NAME),
    settingsPath: path.join(homePath, SETTINGS_FILE_NAME),
  };
}

/**
 * Resolve the DeepSeek Harness home that owns the official credential store.
 * An explicit DSH_HOME is validated instead of silently falling back, so a
 * typo cannot redirect credential resolution to another user's store.
 */
export function resolveDeepSeekCredentialHome(
  options: ResolveDeepSeekCredentialHomeOptions,
): DeepSeekCredentialSourceHome {
  const childValue = options.childProcessEnv?.[DSH_HOME_ENVIRONMENT_NAME];
  if (childValue !== undefined) {
    return createSourceHome('child-process-env', selectExplicitHome(childValue));
  }
  const ambientValue = options.ambientEnv[DSH_HOME_ENVIRONMENT_NAME];
  if (ambientValue !== undefined) {
    return createSourceHome('environment', selectExplicitHome(ambientValue));
  }
  return createSourceHome(
    'default',
    path.join(options.userHome, DEFAULT_HARNESS_HOME_DIRECTORY),
  );
}

/** Describe a credential source home by its logical origin without printing a filesystem path. */
export function describeDeepSeekCredentialHomeOrigin(
  origin: DeepSeekCredentialHomeOrigin,
): string {
  if (origin === 'child-process-env') {
    return 'the child-process DSH_HOME environment variable';
  }
  if (origin === 'environment') {
    return 'the DSH_HOME environment variable';
  }
  return 'the default harness home ~/.dsh';
}
