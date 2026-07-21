import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isRuntimePreparePreset, type WorkflowRuntimeConfig, type RuntimePrepareEntry, type RuntimePreparePreset } from '../models/workflow-types.js';
import { ensurePrivateDirectory } from '../../shared/utils/private-file.js';

export interface RuntimeEnvironmentResult {
  runtimeRoot: string;
  envFile: string;
  prepare: RuntimePrepareEntry[];
  injectedEnv: Record<string, string>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PRESET_SCRIPT_DIR = join(__dirname, 'presets');
const RUNTIME_TEMP_DIRECTORY_PREFIX = 'takt';
const RUNTIME_TEMP_DIRECTORY_HASH_LENGTH = 32;
const PROTECTED_RUNTIME_ENV_KEYS = new Set(['TMPDIR', 'TAKT_RUNTIME_TMP']);
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRESET_SCRIPT_MAP: Record<RuntimePreparePreset, string> = {
  gradle: join(PRESET_SCRIPT_DIR, 'prepare-gradle.sh'),
  node: join(PRESET_SCRIPT_DIR, 'prepare-node.sh'),
};

function isProtectedRuntimeEnvironmentKey(key: string): boolean {
  return process.platform === 'win32'
    ? PROTECTED_RUNTIME_ENV_KEYS.has(key.toUpperCase())
    : PROTECTED_RUNTIME_ENV_KEYS.has(key);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function preserveToolConfigDir(envKey: string, xdgSubdir: string): string {
  return process.env[envKey]
    ?? join(process.env['XDG_CONFIG_HOME'] ?? join(process.env['HOME']!, '.config'), xdgSubdir);
}

function resolveGlabConfigDir(): string {
  if (process.env['GLAB_CONFIG_DIR']) {
    return process.env['GLAB_CONFIG_DIR'];
  }

  if (process.platform === 'darwin') {
    const macOsPath = join(process.env['HOME']!, 'Library', 'Application Support', 'glab-cli');
    if (existsSync(macOsPath)) {
      return macOsPath;
    }
  }

  const xdgBase = process.env['XDG_CONFIG_HOME'] ?? join(process.env['HOME']!, '.config');
  return join(xdgBase, 'glab-cli');
}

/**
 * Resolve the Cursor CLI config directory to preserve across runtime.prepare.
 * Cursor honors CURSOR_CONFIG_DIR (highest precedence, points directly at the
 * config dir) and otherwise XDG_CONFIG_HOME/cursor; its default is ~/.cursor
 * (NOT ~/.config/cursor). Must be evaluated against the ORIGINAL process.env,
 * i.e. before createBaseEnvironment's XDG_CONFIG_HOME override is applied to
 * process.env (which happens later in prepareRuntimeEnvironment).
 */
function resolveCursorConfigDir(): string {
  if (process.env['CURSOR_CONFIG_DIR']) {
    return process.env['CURSOR_CONFIG_DIR'];
  }
  if (process.env['XDG_CONFIG_HOME']) {
    return join(process.env['XDG_CONFIG_HOME'], 'cursor');
  }
  return join(process.env['HOME']!, '.cursor');
}

function createBaseEnvironment(runtimeRoot: string, runtimeTmp: string): Record<string, string> {
  const ghConfigDir = preserveToolConfigDir('GH_CONFIG_DIR', 'gh');
  const glabConfigDir = resolveGlabConfigDir();
  const cursorConfigDir = resolveCursorConfigDir();
  return {
    TMPDIR: runtimeTmp,
    TAKT_RUNTIME_TMP: runtimeTmp,
    XDG_CACHE_HOME: join(runtimeRoot, 'cache'),
    XDG_CONFIG_HOME: join(runtimeRoot, 'config'),
    XDG_STATE_HOME: join(runtimeRoot, 'state'),
    CI: 'true',
    GH_CONFIG_DIR: ghConfigDir,
    GLAB_CONFIG_DIR: glabConfigDir,
    CURSOR_CONFIG_DIR: cursorConfigDir,
  };
}

function splitJavaToolOptions(value: string): string[] {
  const options: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      token += character;
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      token += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      token += character;
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token.length > 0) {
        options.push(token);
        token = '';
      }
      continue;
    }
    token += character;
  }

  if (token.length > 0) options.push(token);
  return options;
}

function quoteJavaToolOptionValue(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function appendJavaTmpdirOption(base: string | undefined, tmpDir: string): string {
  const optionPrefix = '-Djava.io.tmpdir=';
  const option = `${optionPrefix}${quoteJavaToolOptionValue(tmpDir)}`;
  const existingOptions = base === undefined ? [] : splitJavaToolOptions(base);
  return [
    ...existingOptions.filter((entry) => !entry.replace(/^['"]/, '').startsWith(optionPrefix)),
    option,
  ].join(' ');
}

function parseScriptOutput(stdout: string): Record<string, string> {
  const env: Record<string, string> = Object.create(null);
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const normalized = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed;
    const eq = normalized.indexOf('=');
    if (eq < 0) continue;
    const key = normalized.slice(0, eq).trim();
    const value = normalized.slice(eq + 1).trim();
    if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(key)) {
      throw new Error(`Runtime prepare script produced an invalid environment variable name: ${key}`);
    }
    env[key] = value.replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function resolvePrepareScript(cwd: string, entry: RuntimePrepareEntry): string {
  if (isRuntimePreparePreset(entry)) {
    return PRESET_SCRIPT_MAP[entry];
  }
  return isAbsolute(entry) ? entry : resolve(cwd, entry);
}

function hasPreparePreset(entries: RuntimePrepareEntry[], preset: RuntimePreparePreset): boolean {
  return entries.includes(preset);
}

function runPrepareScript(
  cwd: string,
  scriptPath: string,
  runtimeRoot: string,
  runtimeTmp: string,
  env: Record<string, string>,
): Record<string, string> {
  if (!existsSync(scriptPath)) {
    throw new Error(`Runtime prepare script not found: ${scriptPath}`);
  }

  const result = spawnSync('bash', [scriptPath], {
    cwd,
    env: {
      ...process.env,
      ...env,
      TAKT_RUNTIME_ROOT: runtimeRoot,
      TAKT_RUNTIME_TMP: runtimeTmp,
      TAKT_RUNTIME_CACHE: join(runtimeRoot, 'cache'),
      TAKT_RUNTIME_CONFIG: join(runtimeRoot, 'config'),
      TAKT_RUNTIME_STATE: join(runtimeRoot, 'state'),
    },
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(`Runtime prepare script failed: ${scriptPath}${stderr ? ` (${stderr})` : ''}`);
  }

  return parseScriptOutput(result.stdout ?? '');
}

function buildInjectedEnvironment(
  cwd: string,
  runtimeRoot: string,
  runtimeTmp: string,
  prepareEntries: RuntimePrepareEntry[],
): Record<string, string> {
  const env: Record<string, string> = Object.assign(
    Object.create(null) as Record<string, string>,
    createBaseEnvironment(runtimeRoot, runtimeTmp),
  );

  for (const entry of prepareEntries) {
    const scriptPath = resolvePrepareScript(cwd, entry);
    const scriptEnv = runPrepareScript(cwd, scriptPath, runtimeRoot, runtimeTmp, env);
    for (const [key, value] of Object.entries(scriptEnv)) {
      if (!isProtectedRuntimeEnvironmentKey(key)) {
        env[key] = value;
      }
    }
  }

  if (hasPreparePreset(prepareEntries, 'gradle')) {
    env.JAVA_TOOL_OPTIONS = appendJavaTmpdirOption(
      env.JAVA_TOOL_OPTIONS ?? process.env['JAVA_TOOL_OPTIONS'],
      runtimeTmp,
    );
  }
  if (hasPreparePreset(prepareEntries, 'gradle') && !env.GRADLE_USER_HOME) {
    env.GRADLE_USER_HOME = join(runtimeRoot, 'gradle');
  }
  if (hasPreparePreset(prepareEntries, 'node') && !env.npm_config_cache) {
    env.npm_config_cache = join(runtimeRoot, 'npm');
  }

  return env;
}

function ensureRuntimeDirectories(runtimeRoot: string, env: Record<string, string>): void {
  const dirs = new Set<string>([
    runtimeRoot,
    join(runtimeRoot, 'cache'),
    join(runtimeRoot, 'config'),
    join(runtimeRoot, 'state'),
  ]);

  for (const value of Object.values(env)) {
    if (!value || value === 'true') continue;
    if (value.startsWith(runtimeRoot)) {
      dirs.add(value);
    }
  }

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

function resolveRuntimeTemporaryDirectory(runtimeRoot: string): string {
  const systemTmpRoot = realpathSync(process.platform === 'win32' ? tmpdir() : '/tmp');
  const userId = process.getuid?.();
  const userDirectory = userId === undefined
    ? join(systemTmpRoot, RUNTIME_TEMP_DIRECTORY_PREFIX)
    : join(systemTmpRoot, `${RUNTIME_TEMP_DIRECTORY_PREFIX}-${userId}`);
  const worktreeHash = createHash('sha256')
    .update(resolve(runtimeRoot))
    .digest('hex')
    .slice(0, RUNTIME_TEMP_DIRECTORY_HASH_LENGTH);
  const worktreeDirectory = join(userDirectory, worktreeHash);

  ensurePrivateDirectory(userDirectory);
  ensurePrivateDirectory(worktreeDirectory);
  return worktreeDirectory;
}

function writeRuntimeEnvFile(envFile: string, env: Record<string, string>): void {
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
  ];
  for (const [key, value] of Object.entries(env)) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  lines.push('');
  writeFileSync(envFile, lines.join('\n'), 'utf-8');
}

function dedupePrepare(entries: RuntimePrepareEntry[]): RuntimePrepareEntry[] {
  return [...new Set(entries)];
}

export function resolveRuntimeConfig(
  globalRuntime: WorkflowRuntimeConfig | undefined,
  workflowRuntime: WorkflowRuntimeConfig | undefined,
): WorkflowRuntimeConfig | undefined {
  const prepare = workflowRuntime?.prepare?.length
    ? workflowRuntime.prepare
    : globalRuntime?.prepare;
  if (!prepare || prepare.length === 0) {
    return undefined;
  }
  return { prepare: dedupePrepare(prepare) };
}

export function prepareRuntimeEnvironment(
  cwd: string,
  runtime: WorkflowRuntimeConfig | undefined,
): RuntimeEnvironmentResult | undefined {
  const prepareEntries = runtime?.prepare;
  if (!prepareEntries || prepareEntries.length === 0) {
    return undefined;
  }

  const deduped = dedupePrepare(prepareEntries);
  const runtimeRoot = join(cwd, '.takt', '.runtime');
  const envFile = join(runtimeRoot, 'env.sh');
  const runtimeTmp = resolveRuntimeTemporaryDirectory(runtimeRoot);
  const injectedEnv = buildInjectedEnvironment(cwd, runtimeRoot, runtimeTmp, deduped);

  ensureRuntimeDirectories(runtimeRoot, injectedEnv);
  writeRuntimeEnvFile(envFile, injectedEnv);

  for (const [key, value] of Object.entries(injectedEnv)) {
    process.env[key] = value;
  }

  return {
    runtimeRoot,
    envFile,
    prepare: deduped,
    injectedEnv,
  };
}
