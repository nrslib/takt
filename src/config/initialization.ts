/**
 * Initialization module for first-time setup
 *
 * Handles language selection and initial resource setup.
 * Separated from paths.ts to avoid UI dependencies in utility modules.
 */

import { existsSync } from 'node:fs';
import type { Language } from '../models/types.js';
import { DEFAULT_LANGUAGE } from '../constants.js';
import { selectOptionWithDefault } from '../prompt/index.js';
import {
  getGlobalConfigDir,
  getGlobalAgentsDir,
  getGlobalWorkflowsDir,
  getGlobalLogsDir,
  ensureDir,
} from './paths.js';
import {
  copyGlobalResourcesToDir,
  copyLanguageResourcesToDir,
} from '../resources/index.js';
import { setLanguage } from './globalConfig.js';

/**
 * Check if language-specific resources need to be initialized.
 * Returns true if agents or workflows directories don't exist.
 */
export function needsLanguageSetup(): boolean {
  const agentsDir = getGlobalAgentsDir();
  const workflowsDir = getGlobalWorkflowsDir();
  return !existsSync(agentsDir) || !existsSync(workflowsDir);
}

/**
 * Prompt user to select language for resources.
 * Returns 'en' for English (default), 'ja' for Japanese.
 */
export async function promptLanguageSelection(): Promise<Language> {
  const options: { label: string; value: Language }[] = [
    { label: 'English', value: 'en' },
    { label: '日本語 (Japanese)', value: 'ja' },
  ];

  return await selectOptionWithDefault(
    'Select language for default agents and workflows / デフォルトのエージェントとワークフローの言語を選択してください:',
    options,
    DEFAULT_LANGUAGE
  );
}

/**
 * Initialize global takt directory structure with language selection.
 * If agents/workflows don't exist, prompts user for language preference.
 */
export async function initGlobalDirs(): Promise<void> {
  ensureDir(getGlobalConfigDir());
  ensureDir(getGlobalLogsDir());

  // Check if we need to set up language-specific resources
  const needsSetup = needsLanguageSetup();

  if (needsSetup) {
    // Ask user for language preference
    const lang = await promptLanguageSelection();

    // Copy language-specific resources (agents, workflows, config.yaml)
    copyLanguageResourcesToDir(getGlobalConfigDir(), lang);

    // Explicitly save the selected language (handles case where config.yaml existed)
    setLanguage(lang);
  } else {
    // Just copy base global resources (won't overwrite existing)
    copyGlobalResourcesToDir(getGlobalConfigDir());
  }
}
