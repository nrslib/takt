/**
 * Initialization module for first-time setup
 *
 * Handles language selection and initial config.yaml creation.
 * Builtin agents/workflows are loaded via fallback from builtins/
 * and no longer copied to ~/.takt/ on setup.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Language } from '../../../core/models/index.js';
import { DEFAULT_LANGUAGE } from '../../../shared/constants.js';
import { promptInput, selectOptionWithDefault } from '../../../shared/prompt/index.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import { validateProviderModelRequirements } from '../../../core/workflow/provider-model-requirements.js';
import { getExecModelCandidates } from '../../providers/model-candidates.js';
import {
  getGlobalConfigDir,
  getGlobalConfigPath,
  getProjectConfigDir,
  ensureDir,
} from '../paths.js';
import { copyProjectResourcesToDir, getLanguageResourcesDir } from '../../resources/index.js';
import { RUNTIME_PROVIDER_FILENAME } from '../runtime-provider/constants.js';
import {
  generateGlobalRuntimeProviderFile,
  type RuntimeProviderSelection,
} from '../runtime-provider/initialization.js';

type InitialSetupProvider = Exclude<ProviderType, 'mock'>;

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
    'Select language for default agents and workflows / デフォルトのエージェントとワークフローの言語を選択してください:',
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
export async function promptProviderSelection(): Promise<InitialSetupProvider> {
  const options: {
    label: string;
    value: InitialSetupProvider;
  }[] = [
    { label: 'Claude Code (headless CLI)', value: 'claude' },
    { label: 'Claude Agent SDK', value: 'claude-sdk' },
    { label: 'Claude Code terminal (experimental)', value: 'claude-terminal' },
    { label: 'Codex', value: 'codex' },
    { label: 'OpenCode', value: 'opencode' },
    { label: 'Cursor Agent', value: 'cursor' },
    { label: 'GitHub Copilot', value: 'copilot' },
    { label: 'Kiro CLI', value: 'kiro' },
    { label: 'Pi SDK', value: 'pi' },
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

const CUSTOM_MODEL_VALUE = '__custom_model__';

/**
 * Prompt user to select the model for the chosen provider.
 * The selected model is written to runtime.yaml `profiles.default`, whose referenced profile must
 * define both provider and model, so the model must be consistent with the provider (e.g. opencode
 * requires a `provider/model` value). We therefore offer the provider's known models and require an
 * explicit value rather than defaulting to a Claude model name for every provider.
 * Exits process if cancelled (initial setup is required).
 */
export async function promptModelSelection(provider: InitialSetupProvider): Promise<string> {
  const candidates = getExecModelCandidates(provider);
  const options: { label: string; value: string }[] = candidates.map((model) => ({
    label: model,
    value: model,
  }));
  options.push({ label: 'Custom model / モデルを直接入力', value: CUSTOM_MODEL_VALUE });

  const selected = await selectOptionWithDefault(
    'Select model / モデルを選択してください:',
    options,
    candidates[0] ?? CUSTOM_MODEL_VALUE
  );

  if (selected === null) {
    process.exit(0);
  }

  const model = selected === CUSTOM_MODEL_VALUE
    ? await promptCustomModel()
    : selected;

  // Fail fast so a provider that requires a model (e.g. opencode's `provider/model` format) never
  // produces an invalid runtime.yaml default profile on the next run.
  validateProviderModelRequirements(provider, model);
  return model;
}

async function promptCustomModel(): Promise<string> {
  const model = await promptInput('Enter model (e.g. opencode/big-pickle)');
  if (model === null) {
    process.exit(0);
  }
  return model;
}

/** Options for global directory initialization */
export interface InitGlobalDirsOptions {
  /** Skip interactive prompts (CI/non-TTY environments) */
  nonInteractive?: boolean;
}

/**
 * Initialize global takt directory structure with language selection.
 * On first run, creates config.yaml from language template.
 * Agents/workflows are NOT copied — they are loaded via builtin fallback.
 *
 * In non-interactive mode (pipeline mode or no TTY), skips prompts
 * and uses default values so takt works in pipeline/CI environments without config.yaml.
 */
export async function initGlobalDirs(options?: InitGlobalDirsOptions): Promise<void> {
  ensureDir(getGlobalConfigDir());

  // Existing environments (config.yaml already present) keep legacy provider resolution and
  // only get an inactive runtime.yaml; fresh environments generate an active runtime.yaml from
  // the first-run selection (issue #1136).
  const isExistingEnvironment = !needsLanguageSetup();
  let selection: RuntimeProviderSelection | undefined;

  if (!isExistingEnvironment) {
    const isInteractive = !options?.nonInteractive && process.stdin.isTTY === true;

    if (!isInteractive) {
      // Pipeline / non-interactive: skip prompts, use defaults via loadGlobalConfig() fallback.
      // Defer runtime.yaml generation until a real setup selects a provider.
      return;
    }

    const lang = await promptLanguageSelection();
    const provider = await promptProviderSelection();
    const model = await promptModelSelection(provider);

    // The language template already carries `language: <lang>`, so copying it fully persists the
    // language. We deliberately do NOT run a load→save cycle on the global config here: the global
    // config load injects a default `provider: claude`, and saving it would leave a legacy provider
    // signal in config.yaml that conflicts with the active runtime.yaml on the next override-free
    // run. The provider/model selection is the sole source of truth in runtime.yaml
    // `profiles.default` (issue #1136).
    copyLanguageConfigYaml(lang);

    selection = { provider, model };
  }

  generateGlobalRuntimeProviderFile({
    runtimeFilePath: join(getGlobalConfigDir(), RUNTIME_PROVIDER_FILENAME),
    selection,
    hasLegacyProviderConfig: isExistingEnvironment,
  });
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
