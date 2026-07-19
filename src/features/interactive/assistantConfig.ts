import { loadGlobalConfig } from '../../infra/config/global/globalConfig.js';
import { loadProjectConfig } from '../../infra/config/project/projectConfig.js';
import type { AssistantProviderConfig } from '../../core/config/provider-resolution.js';

export function resolveAssistantConfigLayers(projectDir: string): AssistantProviderConfig {
  const project = loadProjectConfig(projectDir);
  const global = loadGlobalConfig();

  return {
    local: {
      provider: project.provider,
      model: project.model,
      taktProviders: project.taktProviders,
    },
    global: {
      provider: global.provider,
      model: global.model,
      taktProviders: global.taktProviders,
    },
  };
}
