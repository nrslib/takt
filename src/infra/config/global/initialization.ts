/**
 * Initialization module for first-time setup
 *
 * Handles language selection and initial config.yaml creation.
 * Builtin agents/pieces are loaded via fallback from builtins/
 * and no longer copied to ~/.takt/ on setup.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Language } from '../../../core/models/index.js';
import { DEFAULT_LANGUAGE } from '../../../shared/constants.js';
import { selectOptionWithDefault } from '../../../shared/prompt/index.js';
import {
  getGlobalConfigDir,
  getGlobalConfigPath,
  getProjectConfigDir,
  ensureDir,
} from '../paths.js';
import { copyProjectResourcesToDir, getLanguageResourcesDir } from '../../resources/index.js';
import { setLanguage, setProvider } from './globalConfig.js';

/**
 * Check if initial setup is needed.
 * Returns true if config.yaml doesn't exist yet.
 */
export function needsLanguageSetup(): boolean {
  return !existsSync(getGlobalConfigPath());
}

/**
 * Prompt user to select language for resources.
 * Returns 'en' for English (default), 'ja' for Japanese.
 * Exits process if cancelled (initial setup is required).
 */
export async function promptLanguageSelection(): Promise<Language> {
  const options: { label: string; value: Language }[] = [
    { label: 'English', value: 'en' },
    { label: '日本語 (Japanese)', value: 'ja' },
  ];

  const result = await selectOptionWithDefault(
    'Select language for default agents and pieces / デフォルトのエージェントとピースの言語を選択してください:',
    options,
    DEFAULT_LANGUAGE
  );

  if (result === null) {
    process.exit(0);
  }

  return result;
}

/**
 * Prompt user to select provider for resources.
 * Exits process if cancelled (initial setup is required).
 */
export async function promptProviderSelection(): Promise<'claude' | 'codex' | 'opencode'> {
  const options: { label: string; value: 'claude' | 'codex' | 'opencode' }[] = [
    { label: 'Claude Code', value: 'claude' },
    { label: 'Codex', value: 'codex' },
    { label: 'OpenCode', value: 'opencode' },
  ];

  const result = await selectOptionWithDefault(
    'Select provider / プロバイダーを選択してください:',
    options,
    'claude'
  );

  if (result === null) {
    process.exit(0);
  }

  return result;
}

/** Options for global directory initialization */
export interface InitGlobalDirsOptions {
  /** Skip interactive prompts (CI/non-TTY environments) */
  nonInteractive?: boolean;
}

/**
 * Initialize global takt directory structure with language selection.
 * On first run, creates config.yaml from language template.
 * Agents/pieces are NOT copied — they are loaded via builtin fallback.
 *
 * In non-interactive mode (pipeline mode or no TTY), skips prompts
 * and uses default values so takt works in pipeline/CI environments without config.yaml.
 */
export async function initGlobalDirs(options?: InitGlobalDirsOptions): Promise<void> {
  ensureDir(getGlobalConfigDir());

  if (needsLanguageSetup()) {
    const isInteractive = !options?.nonInteractive && process.stdin.isTTY === true;

    if (!isInteractive) {
      // Pipeline / non-interactive: skip prompts, use defaults via loadGlobalConfig() fallback
      return;
    }

    const lang = await promptLanguageSelection();
    const provider = await promptProviderSelection();

    // Copy only config.yaml from language resources
    copyLanguageConfigYaml(lang);

    setLanguage(lang);
    setProvider(provider);
  }
}

/** Copy config.yaml from language resources to ~/.takt/ (if not already present) */
function copyLanguageConfigYaml(lang: Language): void {
  const langDir = getLanguageResourcesDir(lang);
  const srcPath = join(langDir, 'config.yaml');
  const destPath = getGlobalConfigPath();
  if (existsSync(srcPath) && !existsSync(destPath)) {
    writeFileSync(destPath, readFileSync(srcPath));
  }
}

/**
 * Initialize project-level .takt directory.
 * Creates .takt/ and copies project resources (e.g., .gitignore).
 * Only copies files that don't exist.
 */
export function initProjectDirs(projectDir: string): void {
  const configDir = getProjectConfigDir(projectDir);
  ensureDir(configDir);
  copyProjectResourcesToDir(configDir);
}
