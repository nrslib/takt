import type {
  FormalSpecMode,
  FormalSpecSetting,
} from '../../core/models/config-types.js';
import { loadGlobalConfig } from '../../infra/config/global/globalConfig.js';
import { loadProjectConfig } from '../../infra/config/project/projectConfig.js';
import { getLabel } from '../../shared/i18n/index.js';
import { confirm } from '../../shared/prompt/confirm.js';
import { resolveTtyPolicy } from '../../shared/prompt/tty.js';

interface FormalSpecSettingLayers {
  projectSetting: FormalSpecSetting | undefined;
  globalSetting: FormalSpecSetting | undefined;
  lang: 'en' | 'ja';
}

export interface ResolvedFormalSpecConfiguration {
  mode: boolean;
  comments: boolean;
}

function resolveFormalSpecSettingLayers(projectDir: string): FormalSpecSettingLayers {
  const projectConfig = loadProjectConfig(projectDir);
  const globalConfig = loadGlobalConfig();
  return {
    projectSetting: projectConfig.assistant?.formalSpec,
    globalSetting: globalConfig.assistant?.formalSpec,
    lang: (projectConfig.language ?? globalConfig.language) === 'ja' ? 'ja' : 'en',
  };
}

function getMode(setting: FormalSpecSetting | undefined): FormalSpecMode | undefined {
  if (setting === undefined) {
    return undefined;
  }
  return typeof setting === 'object' ? setting.mode : setting;
}

function getComments(setting: FormalSpecSetting | undefined): boolean | undefined {
  return typeof setting === 'object' ? setting.comments : undefined;
}

function configuredDefault(setting: Exclude<FormalSpecMode, boolean>): boolean {
  return setting === 'Y/n';
}

function resolveFormalSpecSettingValues(projectDir: string): {
  mode: FormalSpecMode;
  comments: boolean;
  lang: 'en' | 'ja';
} {
  const { projectSetting, globalSetting, lang } = resolveFormalSpecSettingLayers(projectDir);
  const mode = getMode(projectSetting) ?? getMode(globalSetting) ?? 'y/N';
  const comments = getComments(projectSetting) ?? getComments(globalSetting) ?? true;
  return { mode, comments, lang };
}

function resolveModeWithoutPrompt(mode: FormalSpecMode): boolean {
  if (typeof mode === 'boolean') {
    return mode;
  }
  return configuredDefault(mode);
}

export function resolveFormalSpecConfigurationWithoutPrompt(
  projectDir: string,
): ResolvedFormalSpecConfiguration {
  const { mode, comments } = resolveFormalSpecSettingValues(projectDir);
  return {
    mode: resolveModeWithoutPrompt(mode),
    comments,
  };
}

export async function resolveFormalSpecConfiguration(
  projectDir: string,
): Promise<ResolvedFormalSpecConfiguration> {
  const { mode, comments, lang } = resolveFormalSpecSettingValues(projectDir);
  if (typeof mode === 'boolean') {
    return { mode, comments };
  }

  const defaultYes = configuredDefault(mode);
  if (!resolveTtyPolicy().useTty) {
    return { mode: defaultYes, comments };
  }

  return {
    mode: await confirm(getLabel('interactive.formalSpecPrompt', lang), defaultYes),
    comments,
  };
}

export function resolveFormalSpecModeWithoutPrompt(projectDir: string): boolean {
  return resolveFormalSpecConfigurationWithoutPrompt(projectDir).mode;
}

export async function resolveFormalSpecMode(projectDir: string): Promise<boolean> {
  return (await resolveFormalSpecConfiguration(projectDir)).mode;
}

export function resolveFormalSpecCommentsWithoutPrompt(projectDir: string): boolean {
  return resolveFormalSpecConfigurationWithoutPrompt(projectDir).comments;
}
