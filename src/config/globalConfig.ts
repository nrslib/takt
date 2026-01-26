/**
 * Global configuration loader
 *
 * Manages ~/.takt/config.yaml and project-level debug settings.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { GlobalConfigSchema } from '../models/schemas.js';
import type { GlobalConfig, DebugConfig, Language } from '../models/types.js';
import { getGlobalConfigPath, getProjectConfigPath } from './paths.js';
import { DEFAULT_LANGUAGE } from '../constants.js';

/** Load global configuration */
export function loadGlobalConfig(): GlobalConfig {
  const configPath = getGlobalConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(
      `Global config not found: ${configPath}\n` +
      'Run takt once to initialize the configuration.'
    );
  }
  const content = readFileSync(configPath, 'utf-8');
  const raw = parseYaml(content);
  const parsed = GlobalConfigSchema.parse(raw);
  return {
    language: parsed.language,
    trustedDirectories: parsed.trusted_directories,
    defaultWorkflow: parsed.default_workflow,
    logLevel: parsed.log_level,
    provider: parsed.provider,
    model: parsed.model,
    debug: parsed.debug ? {
      enabled: parsed.debug.enabled,
      logFile: parsed.debug.log_file,
    } : undefined,
  };
}

/** Save global configuration */
export function saveGlobalConfig(config: GlobalConfig): void {
  const configPath = getGlobalConfigPath();
  const raw: Record<string, unknown> = {
    language: config.language,
    trusted_directories: config.trustedDirectories,
    default_workflow: config.defaultWorkflow,
    log_level: config.logLevel,
    provider: config.provider,
  };
  if (config.model) {
    raw.model = config.model;
  }
  if (config.debug) {
    raw.debug = {
      enabled: config.debug.enabled,
      log_file: config.debug.logFile,
    };
  }
  writeFileSync(configPath, stringifyYaml(raw), 'utf-8');
}

/** Get current language setting */
export function getLanguage(): Language {
  try {
    const config = loadGlobalConfig();
    return config.language;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/** Set language setting */
export function setLanguage(language: Language): void {
  const config = loadGlobalConfig();
  config.language = language;
  saveGlobalConfig(config);
}

/** Set provider setting */
export function setProvider(provider: 'claude' | 'codex'): void {
  const config = loadGlobalConfig();
  config.provider = provider;
  saveGlobalConfig(config);
}

/** Add a trusted directory */
export function addTrustedDirectory(dir: string): void {
  const config = loadGlobalConfig();
  const resolvedDir = join(dir);
  if (!config.trustedDirectories.includes(resolvedDir)) {
    config.trustedDirectories.push(resolvedDir);
    saveGlobalConfig(config);
  }
}

/** Check if a directory is trusted */
export function isDirectoryTrusted(dir: string): boolean {
  const config = loadGlobalConfig();
  const resolvedDir = join(dir);
  return config.trustedDirectories.some(
    (trusted) => resolvedDir === trusted || resolvedDir.startsWith(trusted + '/')
  );
}

/** Load project-level debug configuration (from .takt/config.yaml) */
export function loadProjectDebugConfig(projectDir: string): DebugConfig | undefined {
  const configPath = getProjectConfigPath(projectDir);
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    const content = readFileSync(configPath, 'utf-8');
    const raw = parseYaml(content);
    if (raw && typeof raw === 'object' && 'debug' in raw) {
      const debug = raw.debug;
      if (debug && typeof debug === 'object') {
        return {
          enabled: Boolean(debug.enabled),
          logFile: typeof debug.log_file === 'string' ? debug.log_file : undefined,
        };
      }
    }
  } catch {
    // Ignore parse errors
  }
  return undefined;
}

/** Get effective debug config (project overrides global) */
export function getEffectiveDebugConfig(projectDir?: string): DebugConfig | undefined {
  const globalConfig = loadGlobalConfig();
  let debugConfig = globalConfig.debug;

  if (projectDir) {
    const projectDebugConfig = loadProjectDebugConfig(projectDir);
    if (projectDebugConfig) {
      debugConfig = projectDebugConfig;
    }
  }

  return debugConfig;
}
