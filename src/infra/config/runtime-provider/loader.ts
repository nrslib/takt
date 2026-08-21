/**
 * Loader for the runtime.yaml provider configuration (issue #1136).
 *
 * Reads the two fixed paths (`~/.takt/runtime.yaml`, `<project>/.takt/runtime.yaml`) with
 * schema validation. Directories are passed explicitly from above — there is no implicit
 * homedir/cwd fallback and no `runtime_file` indirection. When both files exist, project
 * wins: same-name profiles are replaced wholesale (no field-level merge, per order.md:37),
 * disjoint profiles are retained, and the other sections take the project value when present.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { RUNTIME_PROVIDER_FILENAME, RUNTIME_PROVIDER_VERSION } from './constants.js';
import {
  RuntimeProviderFileSchema,
  type RuntimeProviderFile,
  type RuntimeProviderSection,
} from './schema.js';

/** Load and validate a single runtime.yaml. Returns undefined when the file is absent or empty. */
export function loadRuntimeProviderFileAt(filePath: string): RuntimeProviderFile | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  const raw: unknown = parseYaml(readFileSync(filePath, 'utf-8'));
  // An empty document parses to null; treat it as "not configured" rather than a shape error.
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const result = RuntimeProviderFileSchema.safeParse(raw);
  if (!result.success) {
    // Global and project layers share the `runtime.yaml` filename; name the failing path.
    throw new Error(`Invalid ${filePath}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export interface ResolveRuntimeProviderInput {
  globalConfigDir: string;
  projectConfigDir: string;
}

export type RuntimeProviderProfileOrigin = 'global' | 'project';

export interface ResolvedRuntimeProviderFileWithOrigins {
  readonly runtimeFile: RuntimeProviderFile | undefined;
  readonly profileOrigins: ReadonlyMap<string, RuntimeProviderProfileOrigin>;
}

/** Resolve the effective file together with the layer that contributed each profile. */
export function resolveRuntimeProviderFileWithOrigins(
  input: ResolveRuntimeProviderInput,
): ResolvedRuntimeProviderFileWithOrigins {
  const global = loadRuntimeProviderFileAt(join(input.globalConfigDir, RUNTIME_PROVIDER_FILENAME));
  const project = loadRuntimeProviderFileAt(join(input.projectConfigDir, RUNTIME_PROVIDER_FILENAME));
  const profileOrigins = new Map<string, RuntimeProviderProfileOrigin>();
  for (const name of Object.keys(global?.provider?.profiles ?? {})) {
    profileOrigins.set(name, 'global');
  }
  for (const name of Object.keys(project?.provider?.profiles ?? {})) {
    profileOrigins.set(name, 'project');
  }
  return {
    runtimeFile: !global ? project : !project ? global : mergeRuntimeProviderFiles(global, project),
    profileOrigins,
  };
}

/** Resolve the effective runtime.yaml from the global and project layers (project wins). */
export function resolveRuntimeProviderFile(
  input: ResolveRuntimeProviderInput,
): RuntimeProviderFile | undefined {
  return resolveRuntimeProviderFileWithOrigins(input).runtimeFile;
}

function mergeRuntimeProviderFiles(
  global: RuntimeProviderFile,
  project: RuntimeProviderFile,
): RuntimeProviderFile {
  const provider = mergeProviderSections(global.provider, project.provider);
  const globalEnabled = global.companion?.enabled;
  const projectEnabled = project.companion?.enabled;
  const enabled = globalEnabled === undefined && projectEnabled === undefined
    ? undefined
    : globalEnabled !== false && projectEnabled !== false;
  const companion = global.companion === undefined && project.companion === undefined
    ? undefined
    : {
        ...(enabled === undefined ? {} : { enabled }),
        ...(project.companion?.review_mode === undefined
          && global.companion?.review_mode === undefined
          ? {}
          : { review_mode: project.companion?.review_mode ?? global.companion?.review_mode }),
      };
  return provider
    ? {
        version: RUNTIME_PROVIDER_VERSION,
        ...(companion === undefined ? {} : { companion }),
        provider,
      }
    : {
        version: RUNTIME_PROVIDER_VERSION,
        ...(companion === undefined ? {} : { companion }),
      };
}

function mergeProviderSections(
  global: RuntimeProviderSection | undefined,
  project: RuntimeProviderSection | undefined,
): RuntimeProviderSection | undefined {
  if (!global) {
    return project;
  }
  if (!project) {
    return global;
  }

  const merged: RuntimeProviderSection = {};

  const defaults = project.defaults ?? global.defaults;
  if (defaults) {
    merged.defaults = defaults;
  }

  // Same-name profiles are replaced wholesale; disjoint profiles from both layers survive.
  if (global.profiles || project.profiles) {
    merged.profiles = { ...(global.profiles ?? {}), ...(project.profiles ?? {}) };
  }

  const targets = project.targets ?? global.targets;
  if (targets) {
    merged.targets = targets;
  }

  const autoRouting = project.auto_routing ?? global.auto_routing;
  if (autoRouting) {
    merged.auto_routing = autoRouting;
  }

  return merged;
}
