/**
 * Project-level configuration management
 *
 * Manages .takt/config.yaml for project-specific settings.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';

/** Permission mode for the project
 * - default: Uses Agent SDK's acceptEdits mode (auto-accepts file edits, minimal prompts)
 * - sacrifice-my-pc: Auto-approves all permission requests (bypassPermissions)
 *
 * Note: 'confirm' mode is planned but not yet implemented
 */
export type PermissionMode = 'default' | 'sacrifice-my-pc';

/** @deprecated Use PermissionMode instead */
export type ProjectPermissionMode = PermissionMode;

/** Project configuration stored in .takt/config.yaml */
export interface ProjectLocalConfig {
  /** Current workflow name */
  workflow?: string;
  /** Permission mode setting */
  permissionMode?: PermissionMode;
  /** @deprecated Use permissionMode instead. Auto-approve all permissions in this project */
  sacrificeMode?: boolean;
  /** Verbose output mode */
  verbose?: boolean;
  /** Custom settings */
  [key: string]: unknown;
}

/** Default project configuration */
const DEFAULT_PROJECT_CONFIG: ProjectLocalConfig = {
  workflow: 'default',
  permissionMode: 'default',
};

/**
 * Get project takt config directory (.takt in project)
 * Note: Defined locally to avoid circular dependency with paths.ts
 */
function getConfigDir(projectDir: string): string {
  return join(resolve(projectDir), '.takt');
}

/**
 * Get project config file path
 * Note: Defined locally to avoid circular dependency with paths.ts
 */
function getConfigPath(projectDir: string): string {
  return join(getConfigDir(projectDir), 'config.yaml');
}

/**
 * Load project configuration from .takt/config.yaml
 */
export function loadProjectConfig(projectDir: string): ProjectLocalConfig {
  const configPath = getConfigPath(projectDir);

  if (!existsSync(configPath)) {
    return { ...DEFAULT_PROJECT_CONFIG };
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = parse(content) as ProjectLocalConfig | null;
    return { ...DEFAULT_PROJECT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_PROJECT_CONFIG };
  }
}

/**
 * Save project configuration to .takt/config.yaml
 */
export function saveProjectConfig(projectDir: string, config: ProjectLocalConfig): void {
  const configDir = getConfigDir(projectDir);
  const configPath = getConfigPath(projectDir);

  // Ensure directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const content = stringify(config, { indent: 2 });
  writeFileSync(configPath, content, 'utf-8');
}

/**
 * Update a single field in project configuration
 */
export function updateProjectConfig<K extends keyof ProjectLocalConfig>(
  projectDir: string,
  key: K,
  value: ProjectLocalConfig[K]
): void {
  const config = loadProjectConfig(projectDir);
  config[key] = value;
  saveProjectConfig(projectDir, config);
}

/**
 * Get current workflow from project config
 */
export function getCurrentWorkflow(projectDir: string): string {
  const config = loadProjectConfig(projectDir);
  return config.workflow || 'default';
}

/**
 * Set current workflow in project config
 */
export function setCurrentWorkflow(projectDir: string, workflow: string): void {
  updateProjectConfig(projectDir, 'workflow', workflow);
}

/**
 * Get verbose mode from project config
 */
export function isVerboseMode(projectDir: string): boolean {
  const config = loadProjectConfig(projectDir);
  return config.verbose === true;
}
