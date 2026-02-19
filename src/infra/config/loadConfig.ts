import type { GlobalConfig } from '../../core/models/index.js';
import type { MovementProviderOptions } from '../../core/models/piece-types.js';
import type { ProviderPermissionProfiles } from '../../core/models/provider-profiles.js';
import { loadGlobalConfig } from './global/globalConfig.js';
import { loadProjectConfig } from './project/projectConfig.js';
import { envVarNameFromPath } from './env/config-env-overrides.js';

export interface LoadedConfig extends GlobalConfig {
  piece: string;
  provider: NonNullable<GlobalConfig['provider']>;
  verbose: boolean;
  providerOptions?: MovementProviderOptions;
  providerProfiles?: ProviderPermissionProfiles;
}

export function loadConfig(projectDir: string): LoadedConfig {
  const global = loadGlobalConfig();
  const project = loadProjectConfig(projectDir);
  const provider = (project.provider ?? global.provider ?? 'claude') as NonNullable<GlobalConfig['provider']>;

  return {
    ...global,
    piece: project.piece ?? 'default',
    provider,
    autoPr: project.auto_pr ?? global.autoPr,
    draftPr: project.draft_pr ?? global.draftPr,
    model: resolveModel(global, provider),
    verbose: resolveVerbose(project.verbose, global.verbose),
    providerOptions: mergeProviderOptions(global.providerOptions, project.providerOptions),
    providerProfiles: mergeProviderProfiles(global.providerProfiles, project.providerProfiles),
  };
}

function resolveModel(global: GlobalConfig, provider: GlobalConfig['provider']): string | undefined {
  if (!global.model) return undefined;
  const globalProvider = global.provider ?? 'claude';
  const resolvedProvider = provider ?? 'claude';
  if (globalProvider !== resolvedProvider) return undefined;
  return global.model;
}

function resolveVerbose(projectVerbose: boolean | undefined, globalVerbose: boolean | undefined): boolean {
  const envVerbose = loadEnvBooleanSetting('verbose');
  if (envVerbose !== undefined) return envVerbose;
  if (projectVerbose !== undefined) return projectVerbose;
  if (globalVerbose !== undefined) return globalVerbose;
  return false;
}

function loadEnvBooleanSetting(configKey: string): boolean | undefined {
  const envKey = envVarNameFromPath(configKey);
  const raw = process.env[envKey];
  if (raw === undefined) return undefined;

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  throw new Error(`${envKey} must be one of: true, false`);
}

function mergeProviderOptions(
  globalOptions: MovementProviderOptions | undefined,
  projectOptions: MovementProviderOptions | undefined,
): MovementProviderOptions | undefined {
  if (!globalOptions && !projectOptions) return undefined;

  const result: MovementProviderOptions = {};
  if (globalOptions?.codex || projectOptions?.codex) {
    result.codex = { ...globalOptions?.codex, ...projectOptions?.codex };
  }
  if (globalOptions?.opencode || projectOptions?.opencode) {
    result.opencode = { ...globalOptions?.opencode, ...projectOptions?.opencode };
  }
  if (globalOptions?.claude?.sandbox || projectOptions?.claude?.sandbox) {
    result.claude = {
      sandbox: {
        ...globalOptions?.claude?.sandbox,
        ...projectOptions?.claude?.sandbox,
      },
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeProviderProfiles(
  globalProfiles: ProviderPermissionProfiles | undefined,
  projectProfiles: ProviderPermissionProfiles | undefined,
): ProviderPermissionProfiles | undefined {
  if (!globalProfiles && !projectProfiles) return undefined;

  const merged: ProviderPermissionProfiles = { ...(globalProfiles ?? {}) };
  for (const [provider, profile] of Object.entries(projectProfiles ?? {})) {
    const key = provider as keyof ProviderPermissionProfiles;
    const existing = merged[key];
    if (!existing) {
      merged[key] = profile;
      continue;
    }
    merged[key] = {
      defaultPermissionMode: profile.defaultPermissionMode,
      movementPermissionOverrides: {
        ...(existing.movementPermissionOverrides ?? {}),
        ...(profile.movementPermissionOverrides ?? {}),
      },
    };
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}
