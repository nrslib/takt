import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { SchemaShape, TracedValue } from 'traced-config';
import {
  GLOBAL_LEGACY_ENV_SPECS,
  setNestedConfigValue,
  type LegacyEnvSpec,
} from '../env/config-env-overrides.js';
import {
  getGlobalTracedSchema,
  getProjectTracedSchema,
  type TracedOrigin,
} from './tracedConfigSchema.js';
import { applyLegacyEnvSpecs } from './tracedConfigLegacyEnvAdapter.js';
import { loadTraceEntriesViaRuntime } from './tracedConfigRuntimeBridge.js';

type TraceEntry = {
  traced: TracedValue<unknown>;
};

export interface ConfigTrace {
  getOrigin(path: string): TracedOrigin;
}

interface LoadConfigTraceOptions {
  configPath: string;
  fileOrigin: 'global' | 'local';
  schema: SchemaShape;
  legacyEnvSpecs?: readonly LegacyEnvSpec[];
  parseErrorPrefix?: string;
  rootObjectError?: string;
  sanitize?: (value: unknown) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createYamlParser(options: LoadConfigTraceOptions): (content: string) => unknown {
  return (content: string): unknown => {
    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.parseErrorPrefix) {
        throw new Error(`${options.parseErrorPrefix}: ${message}`);
      }
      throw new Error(message);
    }

    const sanitized = options.sanitize ? options.sanitize(parsed) : parsed;
    if (sanitized != null && !isRecord(sanitized)) {
      throw new Error(options.rootObjectError ?? `Configuration error: ${options.configPath} must be a YAML object.`);
    }
    return sanitized ?? {};
  };
}

function getNearestTraceEntry(
  traceEntries: ReadonlyMap<string, TracedValue<unknown>>,
  path: string,
): TraceEntry | undefined {
  let current = path;
  while (current.length > 0) {
    const traced = traceEntries.get(current);
    if (traced && traced.origin !== 'default') {
      return { traced };
    }
    const lastDot = current.lastIndexOf('.');
    if (lastDot < 0) {
      break;
    }
    current = current.slice(0, lastDot);
  }
  return undefined;
}

function getOpaqueAncestorTraceEntry(
  traceEntries: ReadonlyMap<string, TracedValue<unknown>>,
  path: string,
): TraceEntry | undefined {
  const segments = path.split('.');
  for (let index = 1; index < segments.length; index += 1) {
    const ancestorKey = segments.slice(0, index).join('.');
    const traced = traceEntries.get(ancestorKey);
    if (traced?.origin === 'env' || traced?.origin === 'cli') {
      return { traced };
    }
  }
  return undefined;
}

function buildRawConfig(
  schemaKeys: readonly string[],
  traceEntries: ReadonlyMap<string, TracedValue<unknown>>,
): Record<string, unknown> {
  const rawConfig: Record<string, unknown> = {};
  const keys = [...schemaKeys].sort(
    (left, right) => left.split('.').length - right.split('.').length,
  );

  for (const key of keys) {
    const traced = traceEntries.get(key);
    if (!traced || traced.origin === 'default') {
      continue;
    }
    if (getOpaqueAncestorTraceEntry(traceEntries, key)) {
      continue;
    }
    setNestedConfigValue(rawConfig, key, traced.value);
  }

  return rawConfig;
}

function getLegacyNearestTraceEntry(
  legacyTraceEntries: ReadonlyMap<string, TracedValue<unknown>>,
  path: string,
): TraceEntry | undefined {
  let current = path;
  while (current.length > 0) {
    const traced = legacyTraceEntries.get(current);
    if (traced) {
      return { traced };
    }
    const lastDot = current.lastIndexOf('.');
    if (lastDot < 0) {
      break;
    }
    current = current.slice(0, lastDot);
  }
  return undefined;
}

export function loadConfigTrace(options: LoadConfigTraceOptions): {
  parsedConfig: Record<string, unknown>;
  rawConfig: Record<string, unknown>;
  trace: ConfigTrace;
} {
  const parser = createYamlParser(options);
  const parsedConfig = existsSync(options.configPath)
    ? (parser(readFileSync(options.configPath, 'utf-8')) as Record<string, unknown>)
    : {};
  const traceEntries = loadTraceEntriesViaRuntime(options.schema, options.fileOrigin, parsedConfig);
  const rawConfig = buildRawConfig(Object.keys(options.schema), traceEntries);
  const legacyTraceEntries = new Map<string, TracedValue<unknown>>();

  if (options.legacyEnvSpecs) {
    applyLegacyEnvSpecs(rawConfig, legacyTraceEntries, options.legacyEnvSpecs);
  }

  const trace: ConfigTrace = {
    getOrigin(path: string): TracedOrigin {
      const legacy = getLegacyNearestTraceEntry(legacyTraceEntries, path);
      if (legacy) {
        return legacy.traced.origin;
      }
      const opaqueAncestor = getOpaqueAncestorTraceEntry(traceEntries, path);
      if (opaqueAncestor) {
        return opaqueAncestor.traced.origin;
      }
      return getNearestTraceEntry(traceEntries, path)?.traced.origin ?? 'default';
    },
  };

  return { parsedConfig, rawConfig, trace };
}

export function loadGlobalConfigTrace(
  configPath: string,
  sanitize: (value: unknown) => unknown,
): { parsedConfig: Record<string, unknown>; rawConfig: Record<string, unknown>; trace: ConfigTrace } {
  return loadConfigTrace({
    configPath,
    fileOrigin: 'global',
    schema: getGlobalTracedSchema(),
    legacyEnvSpecs: GLOBAL_LEGACY_ENV_SPECS,
    rootObjectError: 'Configuration error: ~/.takt/config.yaml must be a YAML object.',
    sanitize,
  });
}

export function loadProjectConfigTrace(
  configPath: string,
): { parsedConfig: Record<string, unknown>; rawConfig: Record<string, unknown>; trace: ConfigTrace } {
  return loadConfigTrace({
    configPath,
    fileOrigin: 'local',
    schema: getProjectTracedSchema(),
    parseErrorPrefix: `Configuration error: failed to parse ${configPath}`,
    rootObjectError: `Configuration error: ${configPath} must be a YAML object.`,
  });
}
