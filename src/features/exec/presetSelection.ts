import { info } from '../../shared/ui/index.js';
import { DEFAULT_EXEC_CONFIG } from './defaults.js';
import { loadExecPreset, loadLastUsedExecConfig } from './presetStore.js';
import type { ExecConfig } from './types.js';

export function selectInitialExecConfig(cwd: string, preset: string | undefined): ExecConfig {
  if (preset !== undefined) {
    return loadExecPreset(preset, { projectDir: cwd }).config;
  }

  const lastUsed = loadLastUsedExecConfig();
  if (lastUsed !== null) {
    info('Previous configuration loaded');
    return lastUsed;
  }

  info('Starting with default exec configuration');
  return DEFAULT_EXEC_CONFIG;
}
