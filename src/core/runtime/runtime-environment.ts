import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isRuntimePreparePreset, type PieceRuntimeConfig, type RuntimePrepareEntry, type RuntimePreparePreset } from '../models/piece-types.js';

export interface RuntimeEnvironmentResult {
  runtimeRoot: string;
  envFile: string;
  prepare: RuntimePrepareEntry[];
  injectedEnv: Record<string, string>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PRESET_SCRIPT_DIR = join(__dirname, 'presets');
const PRESET_SCRIPT_MAP: Record<RuntimePreparePreset, string> = {
  gradle: join(PRESET_SCRIPT_DIR, 'prepare-gradle.sh'),
  node: join(PRESET_SCRIPT_DIR, 'prepare-node.sh'),
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function preserveToolConfigDir(envKey: string, xdgSubdir: string): string {
  return process.env[envKey]
    ?? join(process.env['XDG_CONFIG_HOME'] ?? join(process.env['HOME']!, '.config'), xdgSubdir);
}

function createBaseEnvironment(runtimeRoot: string): Record<string, string> {
  const ghConfigDir = preserveToolConfigDir('GH_CONFIG_DIR', 'gh');
  return {
    TMPDIR: join(runtimeRoot, 'tmp'),
    XDG_CACHE_HOME: join(runtimeRoot, 'cache'),
    XDG_CONFIG_HOME: join(runtimeRoot, 'config'),
    XDG_STATE_HOME: join(runtimeRoot, 'state'),
    CI: 'true',
    GH_CONFIG_DIR: ghConfigDir,
  };
}

function appendJavaTmpdirOption(base: string | undefined, tmpDir: string): string {
  const option = `-Djava.io.tmpdir=${tmpDir}`;
  if (!base || base.trim().length === 0) return option;
  if (base.includes(option)) return base;
  return `${base} ${option}`.trim();
}

function parseScriptOutput(stdout: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const normalized = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed;
    const eq = normalized.indexOf('=');
    if (eq <= 0) continue;
    const key = normalized.slice(0, eq).trim();
    const value = normalized.slice(eq + 1).trim();
    if (!key) continue;
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
      TAKT_RUNTIME_TMP: join(runtimeRoot, 'tmp'),
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
  prepareEntries: RuntimePrepareEntry[],
): Record<string, string> {
  const env: Record<string, string> = {
    ...createBaseEnvironment(runtimeRoot),
  };

  for (const entry of prepareEntries) {
    const scriptPath = resolvePrepareScript(cwd, entry);
    const scriptEnv = runPrepareScript(cwd, scriptPath, runtimeRoot, env);
    Object.assign(env, scriptEnv);
  }

  if (hasPreparePreset(prepareEntries, 'gradle')) {
    const tmpDir = env.TMPDIR ?? join(runtimeRoot, 'tmp');
    env.JAVA_TOOL_OPTIONS = appendJavaTmpdirOption(process.env['JAVA_TOOL_OPTIONS'], tmpDir);
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
    join(runtimeRoot, 'tmp'),
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
  globalRuntime: PieceRuntimeConfig | undefined,
  pieceRuntime: PieceRuntimeConfig | undefined,
): PieceRuntimeConfig | undefined {
  const prepare = pieceRuntime?.prepare?.length
    ? pieceRuntime.prepare
    : globalRuntime?.prepare;
  if (!prepare || prepare.length === 0) {
    return undefined;
  }
  return { prepare: dedupePrepare(prepare) };
}

export function prepareRuntimeEnvironment(
  cwd: string,
  runtime: PieceRuntimeConfig | undefined,
): RuntimeEnvironmentResult | undefined {
  const prepareEntries = runtime?.prepare;
  if (!prepareEntries || prepareEntries.length === 0) {
    return undefined;
  }

  const deduped = dedupePrepare(prepareEntries);
  const runtimeRoot = join(cwd, '.takt', '.runtime');
  const envFile = join(runtimeRoot, 'env.sh');
  const injectedEnv = buildInjectedEnvironment(cwd, runtimeRoot, deduped);

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
