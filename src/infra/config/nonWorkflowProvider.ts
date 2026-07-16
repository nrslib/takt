import { resolveNonWorkflowProviderModelFromConfig } from '../../core/config/provider-resolution.js';
import type { ProviderModelOutput } from '../../core/provider-resolution.js';
import { loadGlobalConfig } from './global/globalConfig.js';
import { loadProjectConfig } from './project/projectConfig.js';

export function resolveNonWorkflowProviderModel(cwd: string): ProviderModelOutput {
  return resolveNonWorkflowProviderModelFromConfig({
    project: loadProjectConfig(cwd),
    global: loadGlobalConfig(),
  });
}
