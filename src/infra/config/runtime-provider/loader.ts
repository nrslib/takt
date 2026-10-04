/**
 * Loader for the runtime.yaml provider configuration (issue #1136).
 *
 * Reads the global and project runtime configuration paths with schema validation. Directories
 * are passed explicitly from above — there is no implicit homedir/cwd fallback. A selected
 * runtime file replaces the project path while retaining the global layer. When both files
 * exist, project wins: same-name profiles are replaced wholesale (no field-level merge, per order.md:37),
 * disjoint profiles are retained, and the other sections take the project value when present.
 * Named assignments and directory mappings are resolved after the two layers are merged.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { RUNTIME_PROVIDER_FILENAME, RUNTIME_PROVIDER_VERSION } from './constants.js';
import { expandHomePath } from '../pathExpansion.js';
import {
  RuntimeProviderFileSchema,
  type RuntimeProviderFile,
  type RuntimeProviderSection,
  type McpSection,
} from './schema.js';
import { validateMcpSectionReferences } from './mcp-schema.js';
import { hasActiveProviderSection } from './mode.js';

/** Load and validate a single runtime.yaml. Returns undefined when the file is absent or empty. */
export function loadRuntimeProviderFileAt(filePath: string): RuntimeProviderFile | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  return parseRuntimeProviderFile(filePath, readFileSync(filePath, 'utf-8'));
}

function loadSelectedRuntimeProviderFileAt(filePath: string): RuntimeProviderFile | undefined {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`Unable to read runtime file "${filePath}": ${errorMessage(error)}`, { cause: error });
  }
  try {
    return parseRuntimeProviderFile(filePath, source);
  } catch (error) {
    if (error instanceof Error && error.message.includes(filePath)) {
      throw error;
    }
    throw new Error(`Invalid runtime file "${filePath}": ${errorMessage(error)}`, { cause: error });
  }
}

function parseRuntimeProviderFile(filePath: string, source: string): RuntimeProviderFile | undefined {
  const raw: unknown = parseYaml(source);
  // An empty document parses to null; treat it as "not configured" rather than a shape error.
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const result = RuntimeProviderFileSchema.safeParse(raw);
  if (!result.success) {
    // Global and project layers share the `runtime.yaml` filename; name the failing path.
    throw new Error(`Invalid ${filePath}: ${z.prettifyError(result.error)}`);
  }
  if (result.data.mcp !== undefined) {
    validateMcpSectionReferences(result.data.mcp);
  }
  return result.data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ResolveRuntimeProviderInput {
  globalConfigDir: string;
  projectConfigDir: string;
  runtimeAssignment?: string;
  /** Selected file replacing the project runtime.yaml; relative paths use the current directory. */
  runtimeFilePath?: string;
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
  const project = input.runtimeFilePath === undefined
    ? loadRuntimeProviderFileAt(join(input.projectConfigDir, RUNTIME_PROVIDER_FILENAME))
    : loadSelectedRuntimeProviderFileAt(resolve(input.runtimeFilePath));
  const profileOrigins = new Map<string, RuntimeProviderProfileOrigin>();
  for (const name of Object.keys(global?.provider?.profiles ?? {})) {
    profileOrigins.set(name, 'global');
  }
  for (const name of Object.keys(project?.provider?.profiles ?? {})) {
    profileOrigins.set(name, 'project');
  }
  const merged = !global ? project : !project ? global : mergeRuntimeProviderFiles(global, project);
  const normalized = merged === undefined ? undefined : normalizeRuntimeProviderDirectories(merged);
  return {
    runtimeFile: selectRuntimeAssignment(normalized, input),
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
  const mcp = mergeMcpSections(global.mcp, project.mcp);
  const globalEnabled = global.companion?.enabled;
  const projectEnabled = project.companion?.enabled;
  const enabled = globalEnabled === undefined && projectEnabled === undefined
    ? undefined
    : globalEnabled !== false && projectEnabled !== false;
  const loopAnalysis = project.loop_analysis ?? global.loop_analysis;
  const companion = global.companion === undefined && project.companion === undefined
    ? undefined
    : {
        ...(enabled === undefined ? {} : { enabled }),
        ...(project.companion?.review_mode === undefined
          && global.companion?.review_mode === undefined
          ? {}
          : { review_mode: project.companion?.review_mode ?? global.companion?.review_mode }),
        ...(project.companion?.fix_policy === undefined
          && global.companion?.fix_policy === undefined
          ? {}
          : { fix_policy: project.companion?.fix_policy ?? global.companion?.fix_policy }),
      };
  return {
    version: RUNTIME_PROVIDER_VERSION,
    ...(companion === undefined ? {} : { companion }),
    ...(loopAnalysis === undefined ? {} : { loop_analysis: loopAnalysis }),
    ...(provider === undefined ? {} : { provider }),
    ...(mcp === undefined ? {} : { mcp }),
  };
}

/**
 * Merge the `mcp` section across the global and project layers. When both
 * layers carry an `mcp` section, the project's section replaces the global one
 * wholesale — same-name servers are not field-merged, and `defaults`/`targets`
 * take the project value when present (order.md:108, plan MCP-MERGE).
 */
function mergeMcpSections(
  global: McpSection | undefined,
  project: McpSection | undefined,
): McpSection | undefined {
  return project ?? global;
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

  if (global.assignments || project.assignments) {
    merged.assignments = { ...(global.assignments ?? {}), ...(project.assignments ?? {}) };
  }

  if (global.directories || project.directories) {
    merged.directories = mergeDirectoryMappings(global.directories, project.directories);
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

function mergeDirectoryMappings(
  global: Record<string, string> | undefined,
  project: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...normalizeDirectoryMappings(global),
    ...normalizeDirectoryMappings(project),
  };
}

function normalizeRuntimeProviderDirectories(file: RuntimeProviderFile): RuntimeProviderFile {
  const directories = file.provider?.directories;
  if (directories === undefined) {
    return file;
  }
  return {
    ...file,
    provider: {
      ...file.provider,
      directories: normalizeDirectoryMappings(directories),
    },
  };
}

function normalizeDirectoryMappings(
  directories: Record<string, string> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [directory, assignment] of Object.entries(directories ?? {})) {
    normalized[normalizeDirectoryPath(directory)] = assignment;
  }
  return normalized;
}

function normalizeDirectoryPath(directory: string): string {
  const absolutePath = resolve(expandHomePath(directory));
  return existsSync(absolutePath) ? realpathSync(absolutePath) : absolutePath;
}

function selectRuntimeAssignment(
  file: RuntimeProviderFile | undefined,
  input: ResolveRuntimeProviderInput,
): RuntimeProviderFile | undefined {
  const provider = file?.provider;
  const assignments = provider?.assignments ?? {};
  for (const [directory, assignmentName] of Object.entries(provider?.directories ?? {})) {
    if (!Object.hasOwn(assignments, assignmentName)) {
      throw new Error(
        `runtime.yaml provider.directories["${directory}"] references unknown assignment "${assignmentName}"`,
      );
    }
  }

  let assignmentName = input.runtimeAssignment;
  if (assignmentName === undefined && provider?.directories !== undefined) {
    const projectDirectory = normalizeDirectoryPath(dirname(input.projectConfigDir));
    assignmentName = provider.directories[projectDirectory];
  }
  if (assignmentName === undefined) {
    return file;
  }
  const assignment = Object.hasOwn(assignments, assignmentName) ? assignments[assignmentName] : undefined;
  if (
    file === undefined || provider === undefined || assignment === undefined
    || (input.runtimeAssignment !== undefined && !hasActiveProviderSection(file))
  ) {
    const names = Object.keys(assignments);
    const available = names.length === 0
      ? 'No assignments are defined.'
      : `Available assignments: ${names.join(', ')}.`;
    throw new Error(`Cannot select runtime assignment "${assignmentName}". ${available}`);
  }

  const selectedProvider = { ...provider };
  if (assignment.defaults !== undefined) {
    selectedProvider.defaults = assignment.defaults;
  }
  if (assignment.targets !== undefined) {
    selectedProvider.targets = assignment.targets;
  }

  return {
    ...file,
    provider: selectedProvider,
  };
}
