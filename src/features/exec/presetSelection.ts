import { selectOption } from '../../shared/prompt/index.js';
import { info } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import { DEFAULT_EXEC_CONFIG } from './defaults.js';
import { formatExecConfigSummary } from './configOps.js';
import {
  loadExecPreset,
  listExecPresets,
  loadLastUsedExecConfig,
} from './presetStore.js';
import type { ExecConfig } from './types.js';

export async function selectInitialExecConfig(cwd: string, preset: string | undefined): Promise<ExecConfig | null> {
  if (preset !== undefined) {
    return loadExecPreset(preset, { projectDir: cwd }).config;
  }

  const presets = listExecPresets({ projectDir: cwd });
  const hasUserStartupPreset = presets.some((entry) => entry.source !== 'builtin');
  const lastUsed = loadLastUsedExecConfig();
  if (!hasUserStartupPreset && lastUsed === null) {
    info('Starting with default exec configuration');
    return DEFAULT_EXEC_CONFIG;
  }

  const options = [
    ...(lastUsed !== null
      ? [{
          label: 'Previous configuration',
          value: 'last',
          description: formatExecConfigSummary(lastUsed),
        }]
      : []),
    ...presets.map((entry) => ({
      label: sanitizeTerminalText(entry.name),
      value: `preset:${entry.name}`,
      description: `${sanitizeTerminalText(entry.source)} · ${sanitizeTerminalText(entry.description)}`,
    })),
    {
      label: 'Default configuration',
      value: 'default',
      description: formatExecConfigSummary(DEFAULT_EXEC_CONFIG),
    },
  ];

  const selected = await selectOption<string>('Select exec preset', options);
  if (selected === null) {
    return null;
  }
  if (selected === 'last') {
    if (lastUsed === null) {
      throw new Error('Last used exec configuration disappeared during selection.');
    }
    return lastUsed;
  }
  if (selected === 'default') {
    return DEFAULT_EXEC_CONFIG;
  }
  if (selected.startsWith('preset:')) {
    return loadExecPreset(selected.slice('preset:'.length), { projectDir: cwd }).config;
  }
  throw new Error(`Unknown exec startup selection: ${selected}`);
}
