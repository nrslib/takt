import { getGlobalConfigDir, getProjectConfigDir, getRepertoireDir } from '../paths.js';
import { resolveWorkflowConfigValue } from '../resolveWorkflowConfigValue.js';
import type { FacetResolutionContext } from '../loaders/workflowPackageScope.js';
import type { RuntimeProviderProfileOrigin } from './loader.js';

export interface RuntimeProviderResolutionContext extends FacetResolutionContext {
  readonly globalConfigDir: string;
  readonly projectConfigDir: string;
  readonly profileOrigins?: ReadonlyMap<string, RuntimeProviderProfileOrigin>;
}

/** Resource lookup context shared by runtime execution, preview, and doctor compilation. */
export function createRuntimeProviderResolutionContext(
  projectCwd: string,
  profileOrigins?: ReadonlyMap<string, RuntimeProviderProfileOrigin>,
): RuntimeProviderResolutionContext {
  return {
    lang: resolveWorkflowConfigValue(projectCwd, 'language'),
    projectDir: projectCwd,
    workflowDir: getProjectConfigDir(projectCwd),
    repertoireDir: getRepertoireDir(),
    globalConfigDir: getGlobalConfigDir(),
    projectConfigDir: getProjectConfigDir(projectCwd),
    ...(profileOrigins === undefined ? {} : { profileOrigins }),
  };
}

export function resolveRuntimeProfileResourceContext(
  profileName: string,
  context: RuntimeProviderResolutionContext | undefined,
): FacetResolutionContext | undefined {
  if (context === undefined) return undefined;
  const origin = context.profileOrigins?.get(profileName);
  if (origin === 'global') {
    return {
      lang: context.lang,
      workflowDir: context.globalConfigDir,
      repertoireDir: context.repertoireDir,
    };
  }
  return {
    lang: context.lang,
    projectDir: context.projectDir,
    workflowDir: context.projectConfigDir,
    repertoireDir: context.repertoireDir,
  };
}
