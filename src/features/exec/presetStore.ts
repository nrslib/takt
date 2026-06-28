import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { getResourcesDir } from '../../infra/resources/index.js';
import { debugLog } from '../../shared/utils/index.js';
import { assertExecActorName, assertExecConfig, EXEC_EFFORTS, EXEC_PROVIDERS } from './configValidation.js';
import {
  deleteProjectLocalFile,
  listProjectLocalDirectoryEntries,
  ProjectBoundaryError,
  projectLocalFileExists,
  readProjectLocalTextFile,
  writeProjectLocalTextFile,
} from './projectLocalFiles.js';
import type { ExecActorConfig, ExecConfig, ExecEffort, ExecPreset, ExecPresetScope } from './types.js';

interface ExecPresetStoreOptions {
  projectDir: string;
  globalConfigDir?: string;
  builtinPresetsDir?: string;
}

interface LastUsedExecConfigOptions {
  globalConfigDir?: string;
}

interface ExecPresetWriteOptions {
  projectDir: string;
  scope: Exclude<ExecPresetScope, 'builtin'>;
  globalConfigDir?: string;
}

type RawRecord = Record<string, unknown>;
type PresetLocation = { source: ExecPresetScope; filePath: string };
type PresetDirectory = { source: ExecPresetScope; dir: string };

function resolveGlobalConfigDir(options?: LastUsedExecConfigOptions): string {
  return options?.globalConfigDir ?? getGlobalConfigDir();
}

function resolveBuiltinPresetsDir(options?: Pick<ExecPresetStoreOptions, 'builtinPresetsDir'>): string {
  return options?.builtinPresetsDir ?? join(getResourcesDir(), 'exec', 'presets');
}

function getProjectPresetDir(projectDir: string): string {
  return join(projectDir, '.takt', 'exec', 'presets');
}

function getGlobalPresetDir(globalConfigDir: string): string {
  return join(globalConfigDir, 'exec', 'presets');
}

function getWritablePresetDir(options: ExecPresetWriteOptions): string {
  if (options.scope === 'project') {
    return getProjectPresetDir(options.projectDir);
  }
  return getGlobalPresetDir(resolveGlobalConfigDir(options));
}

function getLastUsedConfigPath(globalConfigDir: string): string {
  return join(globalConfigDir, 'exec.yaml');
}

export function validateExecPresetName(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid exec preset name: ${name}`);
  }
  return name;
}

function asRecord(value: unknown, path: string): RawRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid exec config at ${path}: expected object`);
  }
  return value as RawRecord;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid exec config at ${path}: expected non-empty string`);
  }
  return value;
}

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid exec config at ${path}: expected array`);
  }
  return value.map((entry, index) => asString(entry, `${path}[${index}]`));
}

function asProvider(value: unknown, path: string): ExecConfig['session']['provider'] {
  if (value === undefined) {
    return undefined;
  }
  const provider = asString(value, path);
  if (!EXEC_PROVIDERS.includes(provider as ProviderType)) {
    throw new Error(`Invalid exec config at ${path}: unsupported provider "${provider}"`);
  }
  return provider as ProviderType;
}

function asEffort(value: unknown, path: string): ExecEffort | undefined {
  if (value === undefined) {
    return undefined;
  }
  const effort = asString(value, path);
  if (!EXEC_EFFORTS.includes(effort as ExecEffort)) {
    throw new Error(`Invalid exec config at ${path}: unsupported effort "${effort}"`);
  }
  return effort as ExecEffort;
}

function asModel(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asString(value, path);
}

function asPositiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`Invalid exec config at ${path}: expected positive integer`);
  }
  return value as number;
}

function parseActor(value: unknown, path: string): ExecActorConfig {
  const actor = asRecord(value, path);
  const name = asString(actor.name, `${path}.name`);
  assertExecActorName(name, `${path}.name`);
  return {
    name,
    ...(actor.provider !== undefined ? { provider: asProvider(actor.provider, `${path}.provider`) } : {}),
    model: asModel(actor.model, `${path}.model`),
    effort: asEffort(actor.effort, `${path}.effort`),
    instruction: asString(actor.instruction, `${path}.instruction`),
    knowledge: asStringArray(actor.knowledge, `${path}.knowledge`),
    policy: asStringArray(actor.policy, `${path}.policy`),
  };
}

function parseActorList(value: unknown, path: string): ExecActorConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid exec config at ${path}: expected non-empty array`);
  }
  return value.map((entry, index) => parseActor(entry, `${path}[${index}]`));
}

function parseLoopConfig(loop: RawRecord): ExecConfig['loop'] {
  return {
    smallThreshold: asPositiveInteger(loop.threshold, 'exec.loop.threshold'),
    largeThreshold: asPositiveInteger(loop.large_threshold, 'exec.loop.large_threshold'),
    maxSteps: asPositiveInteger(loop.max_steps, 'exec.loop.max_steps'),
  };
}

function parseExecConfig(raw: unknown): ExecConfig {
  const root = asRecord(raw, 'exec');
  const session = asRecord(root.session, 'exec.session');
  const replan = asRecord(root.replan, 'exec.replan');
  const loop = asRecord(root.loop, 'exec.loop');
  const config = {
    session: {
      ...(session.provider !== undefined ? { provider: asProvider(session.provider, 'exec.session.provider') } : {}),
      model: asModel(session.model, 'exec.session.model'),
      effort: asEffort(session.effort, 'exec.session.effort'),
    },
    replan: {
      instruction: asString(replan.instruction, 'exec.replan.instruction'),
      knowledge: asStringArray(replan.knowledge, 'exec.replan.knowledge'),
      policy: asStringArray(replan.policy, 'exec.replan.policy'),
    },
    workers: parseActorList(root.workers, 'exec.workers'),
    reviews: parseActorList(root.reviews, 'exec.reviews'),
    loop: parseLoopConfig(loop),
  };
  assertExecConfig(config);
  return config;
}

function readYamlFile(filePath: string, projectDir?: string): unknown {
  const content = projectDir === undefined
    ? readFileSync(filePath, 'utf-8')
    : readProjectLocalTextFile(projectDir, filePath, 'exec preset');
  return parseYaml(content);
}

function readPresetFile(filePath: string, source: ExecPresetScope, expectedName: string, projectDir?: string): ExecPreset {
  const presetName = validateExecPresetName(expectedName);
  const raw = asRecord(readYamlFile(filePath, projectDir), filePath);
  const declaredName = asString(raw.name, `${filePath}.name`);
  if (declaredName !== presetName) {
    throw new Error(`Invalid exec preset at ${filePath}: name "${declaredName}" must match filename "${presetName}"`);
  }
  return {
    name: presetName,
    description: asString(raw.description, `${filePath}.description`),
    source,
    config: parseExecConfig(raw),
  };
}

function presetFileExists(source: ExecPresetScope, filePath: string, projectDir: string): boolean {
  if (source === 'project') {
    return projectLocalFileExists(projectDir, filePath, 'exec preset');
  }
  return existsSync(filePath);
}

function getPresetDirectories(options: ExecPresetStoreOptions): PresetDirectory[] {
  const globalConfigDir = resolveGlobalConfigDir(options);
  return [
    { source: 'project', dir: getProjectPresetDir(options.projectDir) },
    { source: 'global', dir: getGlobalPresetDir(globalConfigDir) },
    { source: 'builtin', dir: resolveBuiltinPresetsDir(options) },
  ];
}

function getPresetLocations(name: string, options: ExecPresetStoreOptions): PresetLocation[] {
  const presetName = validateExecPresetName(name);
  return getPresetDirectories(options).map((directory) => ({
    source: directory.source,
    filePath: join(directory.dir, `${presetName}.yaml`),
  }));
}

function readPresetLocation(location: PresetLocation, presetName: string, projectDir: string): ExecPreset {
  return readPresetFile(
    location.filePath,
    location.source,
    presetName,
    location.source === 'project' ? projectDir : undefined,
  );
}

function findFirstExistingPresetLocation(name: string, options: ExecPresetStoreOptions): PresetLocation | null {
  const candidates = getPresetLocations(name, options);
  const match = candidates.find((candidate) => presetFileExists(candidate.source, candidate.filePath, options.projectDir));
  return match ?? null;
}

export function loadExecPreset(name: string, options: ExecPresetStoreOptions): ExecPreset {
  const presetName = validateExecPresetName(name);
  const match = findFirstExistingPresetLocation(presetName, options);
  if (match === null) {
    throw new Error(`Exec preset not found: ${presetName}`);
  }
  return readPresetLocation(match, presetName, options.projectDir);
}

function getPresetDirForSource(
  source: ExecPresetScope,
  options: ExecPresetStoreOptions,
  globalConfigDir: string,
): string {
  if (source === 'project') {
    return getProjectPresetDir(options.projectDir);
  }
  if (source === 'global') {
    return getGlobalPresetDir(globalConfigDir);
  }
  return resolveBuiltinPresetsDir(options);
}

export function loadExecPresetFromSource(
  name: string,
  source: ExecPresetScope,
  options: ExecPresetStoreOptions,
): ExecPreset {
  const presetName = validateExecPresetName(name);
  const presetPath = join(
    getPresetDirForSource(source, options, resolveGlobalConfigDir(options)),
    `${presetName}.yaml`,
  );
  if (!presetFileExists(source, presetPath, options.projectDir)) {
    throw new Error(`${source} exec preset not found: ${presetName}`);
  }
  return readPresetFile(presetPath, source, presetName, source === 'project' ? options.projectDir : undefined);
}

function listPresetFiles(source: ExecPresetScope, dir: string, projectDir: string): string[] {
  if (source === 'project') {
    return listProjectLocalDirectoryEntries(projectDir, dir, 'exec preset directory');
  }
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir);
}

export function listExecPresets(options: ExecPresetStoreOptions): ExecPreset[] {
  const dirs = getPresetDirectories(options);
  const presets = new Map<string, ExecPreset>();
  const shadowedNames = new Set<string>();
  for (const { source, dir } of dirs) {
    for (const entry of listPresetFiles(source, dir, options.projectDir)) {
      if (!entry.endsWith('.yaml')) {
        continue;
      }
      try {
        const presetName = validateExecPresetName(basename(entry, '.yaml'));
        if (shadowedNames.has(presetName)) {
          continue;
        }
        shadowedNames.add(presetName);
        const preset = readPresetLocation({ source, filePath: join(dir, entry) }, presetName, options.projectDir);
        presets.set(preset.name, preset);
      } catch (error) {
        if (error instanceof ProjectBoundaryError) {
          throw error;
        }
        debugLog('exec', 'Failed to load preset', { entry, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return [...presets.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function listExecPresetsBySource(
  source: ExecPresetScope,
  options: ExecPresetStoreOptions,
): ExecPreset[] {
  const dir = getPresetDirForSource(source, options, resolveGlobalConfigDir(options));
  const presets: ExecPreset[] = [];
  for (const entry of listPresetFiles(source, dir, options.projectDir)) {
    if (!entry.endsWith('.yaml')) {
      continue;
    }
    try {
      const presetName = validateExecPresetName(basename(entry, '.yaml'));
      presets.push(readPresetFile(join(dir, entry), source, presetName, source === 'project' ? options.projectDir : undefined));
    } catch (error) {
      if (error instanceof ProjectBoundaryError) {
        throw error;
      }
      debugLog('exec', 'Failed to load preset', { entry, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return presets.sort((a, b) => a.name.localeCompare(b.name));
}

function serializeExecConfig(config: ExecConfig): string {
  return stringifyYaml(toYamlExecConfig(config));
}

function toYamlExecConfig(config: ExecConfig): Record<string, unknown> {
  assertExecConfig(config);
  return {
    session: config.session,
    replan: config.replan,
    workers: config.workers,
    reviews: config.reviews,
    loop: {
      threshold: config.loop.smallThreshold,
      large_threshold: config.loop.largeThreshold,
      max_steps: config.loop.maxSteps,
    },
  };
}

function serializeExecPreset(name: string, description: string, config: ExecConfig): string {
  return stringifyYaml({
    name,
    description,
    ...toYamlExecConfig(config),
  });
}

export function saveLastUsedExecConfig(config: ExecConfig, options?: LastUsedExecConfigOptions): void {
  const globalConfigDir = resolveGlobalConfigDir(options);
  mkdirSync(globalConfigDir, { recursive: true });
  writeFileSync(getLastUsedConfigPath(globalConfigDir), serializeExecConfig(config));
}

export function loadLastUsedExecConfig(options?: LastUsedExecConfigOptions): ExecConfig | null {
  const filePath = getLastUsedConfigPath(resolveGlobalConfigDir(options));
  if (!existsSync(filePath)) {
    return null;
  }
  return parseExecConfig(readYamlFile(filePath));
}

export function saveExecPreset(
  name: string,
  description: string,
  config: ExecConfig,
  options: ExecPresetWriteOptions,
): void {
  const presetName = validateExecPresetName(name);
  const presetDir = getWritablePresetDir(options);
  const content = serializeExecPreset(presetName, description, config);
  if (options.scope === 'project') {
    writeProjectLocalTextFile(options.projectDir, join(presetDir, `${presetName}.yaml`), content, 'exec preset');
    return;
  }
  mkdirSync(presetDir, { recursive: true });
  writeFileSync(join(presetDir, `${presetName}.yaml`), content);
}

export function deleteExecPreset(name: string, options: ExecPresetWriteOptions): void {
  const presetName = validateExecPresetName(name);
  const presetPath = join(getWritablePresetDir(options), `${presetName}.yaml`);
  if (!presetFileExists(options.scope, presetPath, options.projectDir)) {
    throw new Error(`${options.scope} exec preset not found: ${presetName}`);
  }
  if (options.scope === 'project') {
    deleteProjectLocalFile(options.projectDir, presetPath, 'exec preset');
    return;
  }
  rmSync(presetPath);
}
