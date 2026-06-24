import { selectOption } from '../../shared/prompt/index.js';
import { info } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import type { SessionContext } from '../interactive/aiCaller.js';
import {
  deleteExecPreset,
  loadExecPresetFromSource,
  listExecPresetsBySource,
  saveExecPreset,
} from './presetStore.js';
import { promptText } from './promptUtils.js';
import type { ExecConfig, ExecPresetScope } from './types.js';

type PresetSetupAction = 'load' | 'save' | 'delete' | 'back';
type WritablePresetScope = 'project' | 'global';
type LoadablePresetScope = ExecPresetScope;

async function selectPresetScope(message: string): Promise<WritablePresetScope | null> {
  return await selectOption<WritablePresetScope>(message, [
    { label: 'Project', value: 'project', description: '.takt/exec/presets' },
    { label: 'Global', value: 'global', description: '~/.takt/exec/presets' },
  ]);
}

async function selectLoadPresetScope(): Promise<LoadablePresetScope | null> {
  return await selectOption<LoadablePresetScope>('Preset load source', [
    { label: 'Builtin', value: 'builtin', description: 'builtins/exec/presets' },
    { label: 'Project', value: 'project', description: '.takt/exec/presets' },
    { label: 'Global', value: 'global', description: '~/.takt/exec/presets' },
  ]);
}

async function selectPresetConfig(cwd: string): Promise<ExecConfig | null> {
  const source = await selectLoadPresetScope();
  if (source === null) {
    return null;
  }
  const presets = listExecPresetsBySource(source, { projectDir: cwd });
  const selected = await selectOption<string>(`Load ${source} preset`, presets.map((preset) => ({
    label: sanitizeTerminalText(preset.name),
    value: preset.name,
    description: sanitizeTerminalText(preset.description),
  })));
  return selected === null ? null : loadExecPresetFromSource(selected, source, { projectDir: cwd }).config;
}

async function saveCurrentConfigAsPreset(cwd: string, config: ExecConfig, lang: SessionContext['lang']): Promise<void> {
  const scope = await selectPresetScope('Preset save scope');
  if (scope === null) {
    return;
  }
  const name = await promptText('Preset name', 'custom', lang);
  const description = await promptText('Preset description', 'Custom exec preset', lang);
  saveExecPreset(name, description, config, { projectDir: cwd, scope });
  info(`Saved ${sanitizeTerminalText(scope)} exec preset: ${sanitizeTerminalText(name)}`);
}

async function deleteWritablePreset(cwd: string): Promise<void> {
  const scope = await selectPresetScope('Preset delete scope');
  if (scope === null) {
    return;
  }
  const presets = listExecPresetsBySource(scope, { projectDir: cwd });
  const selected = await selectOption<string>(`Delete ${scope} preset`, presets.map((preset) => ({
    label: sanitizeTerminalText(preset.name),
    value: preset.name,
    description: sanitizeTerminalText(preset.description),
  })));
  if (selected === null) {
    return;
  }
  deleteExecPreset(selected, { projectDir: cwd, scope });
  info(`Deleted ${sanitizeTerminalText(scope)} exec preset: ${sanitizeTerminalText(selected)}`);
}

export async function editPresetSetup(cwd: string, config: ExecConfig, lang: SessionContext['lang']): Promise<ExecConfig> {
  const action = await selectOption<PresetSetupAction>('Preset', [
    { label: 'Load preset', value: 'load' },
    { label: 'Save current preset', value: 'save' },
    { label: 'Delete preset', value: 'delete' },
    { label: 'Back', value: 'back' },
  ]);
  if (action === 'load') {
    return await selectPresetConfig(cwd) ?? config;
  }
  if (action === 'save') {
    await saveCurrentConfigAsPreset(cwd, config, lang);
    return config;
  }
  if (action === 'delete') {
    await deleteWritablePreset(cwd);
  }
  return config;
}
