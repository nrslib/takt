import { join } from 'node:path';
import { info } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import type { SessionContext } from '../interactive/aiCaller.js';
import {
  deleteExecPreset,
  loadExecPresetFromSource,
  listExecPresetsBySource,
  saveExecPreset,
  validateExecPresetName,
} from './presetStore.js';
import { DEFAULT_EXEC_CONFIG } from './defaults.js';
import { execLabel, execScopeLabel, type ExecLanguage } from './labels.js';
import { writeProjectLocalTextFile } from './projectLocalFiles.js';
import { promptTextOrCancel, selectExecOption } from './promptUtils.js';
import { resolveExecConfigProviderModel, type ExecProviderModelDefaults } from './runtimeConfig.js';
import type { ExecConfig, ExecPresetScope } from './types.js';
import { buildExecWorkflowYaml } from './workflowTemplate.js';

type PresetSetupAction = 'load' | 'save' | 'delete' | 'export' | 'back';
type WritablePresetScope = 'project' | 'global';
type LoadablePresetScope = ExecPresetScope | 'default';

async function selectPresetScope(message: string, lang: ExecLanguage): Promise<WritablePresetScope | null> {
  return await selectExecOption<WritablePresetScope>(lang, message, [
    { label: execScopeLabel(lang, 'project'), value: 'project', description: execLabel(lang, 'preset.projectDescription') },
    { label: execScopeLabel(lang, 'global'), value: 'global', description: execLabel(lang, 'preset.globalDescription') },
  ]);
}

async function selectLoadPresetScope(lang: ExecLanguage): Promise<LoadablePresetScope | null> {
  return await selectExecOption<LoadablePresetScope>(lang, execLabel(lang, 'preset.loadSource'), [
    { label: execScopeLabel(lang, 'default'), value: 'default', description: execLabel(lang, 'preset.defaultDescription') },
    { label: execScopeLabel(lang, 'builtin'), value: 'builtin', description: execLabel(lang, 'preset.builtinDescription') },
    { label: execScopeLabel(lang, 'project'), value: 'project', description: execLabel(lang, 'preset.projectDescription') },
    { label: execScopeLabel(lang, 'global'), value: 'global', description: execLabel(lang, 'preset.globalDescription') },
  ]);
}

async function selectPresetConfig(cwd: string, lang: ExecLanguage): Promise<ExecConfig | null> {
  const source = await selectLoadPresetScope(lang);
  if (source === null) {
    return null;
  }
  if (source === 'default') {
    return DEFAULT_EXEC_CONFIG;
  }
  const presets = listExecPresetsBySource(source, { projectDir: cwd });
  const selected = await selectExecOption<string>(lang, execLabel(lang, 'preset.loadFromSource', { source: execScopeLabel(lang, source) }), presets.map((preset) => ({
    label: sanitizeTerminalText(preset.name),
    value: preset.name,
    description: sanitizeTerminalText(preset.description),
  })));
  return selected === null ? null : loadExecPresetFromSource(selected, source, { projectDir: cwd }).config;
}

async function saveCurrentConfigAsPreset(cwd: string, config: ExecConfig, lang: SessionContext['lang']): Promise<void> {
  const scope = await selectPresetScope(execLabel(lang, 'preset.saveScope'), lang);
  if (scope === null) {
    return;
  }
  const name = await promptTextOrCancel(execLabel(lang, 'preset.namePrompt'), 'custom', lang);
  if (name === null) {
    return;
  }
  const description = await promptTextOrCancel(execLabel(lang, 'preset.descriptionPrompt'), execLabel(lang, 'preset.descriptionDefault'), lang);
  if (description === null) {
    return;
  }
  saveExecPreset(name, description, config, { projectDir: cwd, scope });
  info(execLabel(lang, 'preset.saved', {
    scope: sanitizeTerminalText(execScopeLabel(lang, scope)),
    name: sanitizeTerminalText(name),
  }));
}

async function deleteWritablePreset(cwd: string, lang: ExecLanguage): Promise<void> {
  const scope = await selectPresetScope(execLabel(lang, 'preset.deleteScope'), lang);
  if (scope === null) {
    return;
  }
  const presets = listExecPresetsBySource(scope, { projectDir: cwd });
  const selected = await selectExecOption<string>(lang, execLabel(lang, 'preset.deleteFromSource', { source: execScopeLabel(lang, scope) }), presets.map((preset) => ({
    label: sanitizeTerminalText(preset.name),
    value: preset.name,
    description: sanitizeTerminalText(preset.description),
  })));
  if (selected === null) {
    return;
  }
  deleteExecPreset(selected, { projectDir: cwd, scope });
  info(execLabel(lang, 'preset.deleted', {
    scope: sanitizeTerminalText(execScopeLabel(lang, scope)),
    name: sanitizeTerminalText(selected),
  }));
}

export async function exportPresetAsWorkflow(
  cwd: string,
  lang: ExecLanguage,
  providerModelDefaults: ExecProviderModelDefaults,
): Promise<void> {
  const config = await selectPresetConfig(cwd, lang);
  if (config === null) {
    return;
  }
  const name = await promptTextOrCancel(execLabel(lang, 'preset.exportNamePrompt'), 'exported-exec', lang);
  if (name === null) {
    return;
  }
  validateExecPresetName(name);
  const resolvedConfig = resolveExecConfigProviderModel(config, providerModelDefaults);
  const yaml = buildExecWorkflowYaml(resolvedConfig, { workflowName: name, taskDescription: name });
  writeProjectLocalTextFile(cwd, join(cwd, '.takt', 'workflows', `${name}.yaml`), yaml, 'exec workflow');
  info(execLabel(lang, 'preset.exported', { name: sanitizeTerminalText(name) }));
}

export async function editPresetSetup(cwd: string, config: ExecConfig, lang: SessionContext['lang'], providerModelDefaults: ExecProviderModelDefaults): Promise<ExecConfig> {
  const action = await selectExecOption<PresetSetupAction>(lang, execLabel(lang, 'preset.menu'), [
    { label: execLabel(lang, 'preset.load'), value: 'load' },
    { label: execLabel(lang, 'preset.saveCurrent'), value: 'save' },
    { label: execLabel(lang, 'preset.delete'), value: 'delete' },
    { label: execLabel(lang, 'preset.exportAsWorkflow'), value: 'export' },
    { label: execLabel(lang, 'common.back'), value: 'back' },
  ]);
  if (action === 'load') {
    return await selectPresetConfig(cwd, lang) ?? config;
  }
  if (action === 'save') {
    await saveCurrentConfigAsPreset(cwd, config, lang);
    return config;
  }
  if (action === 'delete') {
    await deleteWritablePreset(cwd, lang);
    return config;
  }
  if (action === 'export') {
    await exportPresetAsWorkflow(cwd, lang, providerModelDefaults);
    return config;
  }
  return config;
}
