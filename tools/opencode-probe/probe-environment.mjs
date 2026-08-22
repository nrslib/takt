import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PROBE_WORKER_ENV = 'TAKT_PROMPT_EVAL_WORKER';
const INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  'PATH',
  'Path',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
]);

function inheritRequiredEnvironment(source) {
  const environment = {};
  for (const key of INHERITED_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) {
      environment[key] = source[key];
    }
  }
  return environment;
}

export function prepareIsolatedProbeEnvironment(source, runtimeRoot) {
  const home = join(runtimeRoot, 'home');
  const config = join(runtimeRoot, 'config');
  const data = join(runtimeRoot, 'data');
  const cache = join(runtimeRoot, 'cache');
  const state = join(runtimeRoot, 'state');
  const appData = join(runtimeRoot, 'appdata');
  const localAppData = join(runtimeRoot, 'local-appdata');
  const temporary = join(runtimeRoot, 'tmp');
  for (const directory of [home, config, data, cache, state, appData, localAppData, temporary]) {
    mkdirSync(directory, { recursive: true });
  }

  return {
    ...inheritRequiredEnvironment(source),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    OPENCODE_CONFIG_DIR: join(config, 'opencode'),
    OPENCODE_DB: join(data, 'opencode.db'),
  };
}

export function markProbeWorkerEnvironment(source) {
  return { ...source, [PROBE_WORKER_ENV]: '1' };
}

export function isProbeWorkerEnvironment(source) {
  return source[PROBE_WORKER_ENV] === '1';
}
