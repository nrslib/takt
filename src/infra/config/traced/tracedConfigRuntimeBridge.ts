import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { SchemaShape, TracedValue } from 'traced-config';
import { ensureCurrentTmpDirExists } from '../../../shared/utils/index.js';
import { buildChildProcessEnv } from '../../../shared/utils/child-process-env.js';

type SerializedSchemaFormat = 'string' | 'number' | 'boolean' | 'json' | undefined;

type SerializedSchemaEntry = {
  default?: unknown;
  doc: string;
  format?: SerializedSchemaFormat;
  env?: string;
  sources?: {
    global?: boolean;
    local?: boolean;
    env?: boolean;
    cli?: boolean;
  };
};

type RuntimeLoadInput = {
  schemaGroups: Array<Record<string, SerializedSchemaEntry>>;
  fileOrigin: 'global' | 'local';
  tempConfigPath?: string;
};

type RuntimeLoadOutput = {
  traceEntries: Array<[string, TracedValue<unknown>]>;
};

const require = createRequire(import.meta.url);
const { execFileSync: execFileSyncRuntime } = require('node:child_process') as typeof import('node:child_process');
const { createHash: createHashRuntime } = require('node:crypto') as typeof import('node:crypto');

function executeRuntimeLoader(input: RuntimeLoadInput): string {
  const stdout = execFileSyncRuntime(
    process.execPath,
    ['--input-type=module', '-e', TRACED_CONFIG_RUNTIME_SCRIPT],
    {
      cwd: TAKT_PACKAGE_ROOT,
      env: buildChildProcessEnv(),
      input: JSON.stringify(input),
      encoding: 'utf-8',
    },
  );
  return stdout.trim();
}

function serializeSchema(schema: SchemaShape): Record<string, SerializedSchemaEntry> {
  const serialized: Record<string, SerializedSchemaEntry> = {};
  for (const [key, entry] of Object.entries(schema)) {
    let format: SerializedSchemaFormat;
    if (entry.format === String) format = 'string';
    else if (entry.format === Number) format = 'number';
    else if (entry.format === Boolean) format = 'boolean';
    else if (entry.format === 'json') format = 'json';
    else format = undefined;

    serialized[key] = {
      default: entry.default,
      doc: entry.doc,
      format,
      env: entry.env,
      sources: entry.sources,
    };
  }
  return serialized;
}

function coerceJsonEnvValue(
  key: string,
  format: SerializedSchemaFormat,
  traced: TracedValue<unknown>,
): TracedValue<unknown> {
  if (format !== 'json' || (traced.origin !== 'env' && traced.origin !== 'cli') || typeof traced.value !== 'string') {
    return traced;
  }

  try {
    return {
      ...traced,
      value: JSON.parse(traced.value),
    };
  } catch {
    throw new Error(`Invalid JSON override for ${key}`);
  }
}

function hasSchemaCollision(schemaKeys: readonly string[], key: string): boolean {
  return schemaKeys.some((candidate) =>
    candidate === key || candidate.startsWith(`${key}.`) || key.startsWith(`${candidate}.`),
  );
}

function partitionSchema(schema: SchemaShape): SchemaShape[] {
  const groups: SchemaShape[] = [];
  for (const [key, entry] of Object.entries(schema)) {
    const group = groups.find((candidate) => !hasSchemaCollision(Object.keys(candidate), key));
    if (group) {
      group[key] = entry;
      continue;
    }
    groups.push({ [key]: entry });
  }
  return groups;
}

const TRACED_CONFIG_RUNTIME_SCRIPT = `
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const tracedConfigModuleUrl = import.meta.resolve('traced-config');
const { tracedConfig } = await import(tracedConfigModuleUrl);
const traceEntries = [];
for (const schemaGroup of input.schemaGroups) {
  const schema = {};
  for (const [key, entry] of Object.entries(schemaGroup)) {
    let format;
    if (entry.format === 'string') format = String;
    else if (entry.format === 'number') format = Number;
    else if (entry.format === 'boolean') format = Boolean;
    else if (entry.format === 'json') format = 'json';
    schema[key] = {
      default: entry.default,
      doc: entry.doc,
      format,
      env: entry.env,
      sources: entry.sources,
    };
  }

  const config = tracedConfig({
    defaultSources: { env: false, cli: false },
    schema,
  });

  if (input.tempConfigPath) {
    await config.loadFile([{ path: input.tempConfigPath, label: input.fileOrigin }]);
  }

  for (const key of Object.keys(schema)) {
    traceEntries.push([key, config.getTraced(key)]);
  }
}
process.stdout.write(JSON.stringify({ traceEntries }));
`;

const TAKT_PACKAGE_ROOT = dirname(fileURLToPath(new URL('../../../../package.json', import.meta.url)));

const MAX_RUNTIME_LOAD_CACHE_ENTRIES = 32;

/**
 * Content-addressed memoization of runtime loader results.
 *
 * The child process output depends only on: the constant loader script, the
 * serialized schema groups, the file origin, the temp config file content, and
 * the env vars traced-config reads (entries with `sources.env === true`). All
 * of those are captured in the cache key, so a hit can safely skip the child
 * process spawn (~60ms per config load).
 *
 * The map is module-private and only ever filled with real runtime output, so
 * tests still cannot substitute trace results by mocking node:child_process —
 * a mocked execFileSync is never called and never populates this cache.
 */
const runtimeLoadCache = new Map<string, string>();

/** Mirrors traced-config's naming.toScreamingSnake for entries without an explicit env name. */
function toScreamingSnake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toUpperCase();
}

/**
 * Snapshot of the env vars the runtime loader can read. The loader script pins
 * `defaultSources: { env: false, cli: false }`, so only entries that
 * explicitly set `sources.env === true` resolve from process.env; traced-config
 * derives the env name from the key when `env` is omitted.
 */
function collectEnvDependencies(
  schemaGroups: ReadonlyArray<Record<string, SerializedSchemaEntry>>,
): Array<[string, string | null]> {
  const names = new Set<string>();
  for (const group of schemaGroups) {
    for (const [key, entry] of Object.entries(group)) {
      if (entry.sources?.env === true) {
        names.add(entry.env ?? toScreamingSnake(key));
      }
    }
  }
  return [...names].sort().map((name) => [name, process.env[name] ?? null]);
}

function buildRuntimeLoadCacheKey(
  schemaGroups: ReadonlyArray<Record<string, SerializedSchemaEntry>>,
  fileOrigin: 'global' | 'local',
  configYaml: string | undefined,
): string {
  const payload = JSON.stringify({
    schemaGroups,
    fileOrigin,
    configYaml: configYaml ?? null,
    env: collectEnvDependencies(schemaGroups),
  });
  return createHashRuntime('sha256').update(payload).digest('hex');
}

function runRuntimeLoaderProcess(
  schemaGroups: Array<Record<string, SerializedSchemaEntry>>,
  fileOrigin: 'global' | 'local',
  configYaml: string | undefined,
): string {
  const tempDir = mkdtempSync(join(ensureCurrentTmpDirExists(), 'takt-traced-config-'));

  try {
    let tempConfigPath: string | undefined;
    if (configYaml !== undefined) {
      tempConfigPath = join(tempDir, 'config.yaml');
      writeFileSync(tempConfigPath, configYaml, 'utf-8');
    }

    const input: RuntimeLoadInput = { schemaGroups, fileOrigin, tempConfigPath };
    return executeRuntimeLoader(input);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Test hook: drops memoized runtime results so the next load spawns the real child process. */
export function clearRuntimeTraceCache(): void {
  runtimeLoadCache.clear();
}

export function loadTraceEntriesViaRuntime(
  schema: SchemaShape,
  fileOrigin: 'global' | 'local',
  parsedConfig: Record<string, unknown>,
): Map<string, TracedValue<unknown>> {
  const schemaGroups = partitionSchema(schema).map((schemaGroup) => serializeSchema(schemaGroup));
  const configYaml = Object.keys(parsedConfig).length > 0
    ? stringifyYaml(parsedConfig)
    : undefined;

  const cacheKey = buildRuntimeLoadCacheKey(schemaGroups, fileOrigin, configYaml);
  let runtimeOutputJson = runtimeLoadCache.get(cacheKey);
  if (runtimeOutputJson === undefined) {
    runtimeOutputJson = runRuntimeLoaderProcess(schemaGroups, fileOrigin, configYaml);
    if (runtimeLoadCache.size >= MAX_RUNTIME_LOAD_CACHE_ENTRIES) {
      const oldestKey = runtimeLoadCache.keys().next().value;
      if (oldestKey !== undefined) {
        runtimeLoadCache.delete(oldestKey);
      }
    }
    runtimeLoadCache.set(cacheKey, runtimeOutputJson);
  }

  const result = JSON.parse(runtimeOutputJson) as RuntimeLoadOutput;
  const traceEntries = new Map<string, TracedValue<unknown>>();
  for (const [key, traced] of result.traceEntries) {
    const entry = schemaGroups.find((group) => key in group)?.[key];
    if (!entry) {
      throw new Error(`Missing traced-config schema entry for ${key}`);
    }
    traceEntries.set(key, coerceJsonEnvValue(key, entry.format, traced));
  }
  return traceEntries;
}
