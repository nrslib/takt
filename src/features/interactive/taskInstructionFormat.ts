import type { FormalSpecSetting } from '../../core/models/config-types.js';
import { loadGlobalConfig } from '../../infra/config/global/globalConfig.js';
import { loadProjectConfig } from '../../infra/config/project/projectConfig.js';
import { getLabel } from '../../shared/i18n/index.js';
import { confirm } from '../../shared/prompt/confirm.js';
import { resolveTtyPolicy } from '../../shared/prompt/tty.js';

interface ResolvedFormalSpecSetting {
  setting: FormalSpecSetting;
  lang: 'en' | 'ja';
}

function resolveFormalSpecSetting(projectDir: string): ResolvedFormalSpecSetting {
  const projectConfig = loadProjectConfig(projectDir);
  const globalConfig = loadGlobalConfig();
  return {
    setting: projectConfig.assistant?.formalSpec ?? globalConfig.assistant?.formalSpec ?? 'y/N',
    lang: (projectConfig.language ?? globalConfig.language) === 'ja' ? 'ja' : 'en',
  };
}

function configuredDefault(setting: Exclude<FormalSpecSetting, boolean>): boolean {
  return setting === 'Y/n';
}

export function resolveFormalSpecModeWithoutPrompt(projectDir: string): boolean {
  const { setting } = resolveFormalSpecSetting(projectDir);
  if (typeof setting === 'boolean') {
    return setting;
  }
  return configuredDefault(setting);
}

export async function resolveFormalSpecMode(projectDir: string): Promise<boolean> {
  const { setting, lang } = resolveFormalSpecSetting(projectDir);
  if (typeof setting === 'boolean') {
    return setting;
  }

  const defaultYes = configuredDefault(setting);
  if (!resolveTtyPolicy().useTty) {
    return defaultYes;
  }

  return confirm(getLabel('interactive.formalSpecPrompt', lang), defaultYes);
}
