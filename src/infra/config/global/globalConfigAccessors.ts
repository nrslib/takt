import type { Language } from '../../../core/models/index.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import { DEFAULT_LANGUAGE } from '../../../shared/constants.js';
import { loadGlobalConfig, loadGlobalConfigTraceState, saveGlobalConfig } from './globalConfigCore.js';
import { loadProjectConfig, loadProjectConfigTraceState, saveProjectConfig } from '../project/projectConfig.js';

const ROUTING_TELEMETRY_CONFIG_PATH = 'telemetry.routing_decisions';
const ROUTING_TELEMETRY_ENV_VAR = 'TAKT_TELEMETRY_ROUTING_DECISIONS';

export interface RoutingTelemetryStatus {
  localRecordingEnabled: boolean;
}

function assertRoutingTelemetryNotEnvOverridden(projectDir?: string): void {
  if (projectDir !== undefined) {
    const projectOrigin = loadProjectConfigTraceState(projectDir).getOrigin(ROUTING_TELEMETRY_CONFIG_PATH);
    if (projectOrigin === 'env') {
      throw new Error(
        `${ROUTING_TELEMETRY_ENV_VAR} is set; unset it before changing local routing decision recording with takt telemetry enable|disable.`,
      );
    }
  }

  const globalOrigin = loadGlobalConfigTraceState().getOrigin(ROUTING_TELEMETRY_CONFIG_PATH);
  if (globalOrigin === 'env') {
    throw new Error(
      `${ROUTING_TELEMETRY_ENV_VAR} is set; unset it before changing local routing decision recording with takt telemetry enable|disable.`,
    );
  }
}

export function getDisabledBuiltins(): string[] {
  const config = loadGlobalConfig();
  return config.disabledBuiltins ?? [];
}

export function getBuiltinWorkflowsEnabled(): boolean {
  const config = loadGlobalConfig();
  return config.enableBuiltinWorkflows !== false;
}

export function getLanguage(): Language {
  const config = loadGlobalConfig();
  return config.language ?? DEFAULT_LANGUAGE;
}

export function setLanguage(language: Language): void {
  const config = loadGlobalConfig();
  config.language = language;
  saveGlobalConfig(config);
}

export function setProvider(provider: ProviderType): void {
  const config = loadGlobalConfig();
  config.provider = provider;
  saveGlobalConfig(config);
}

export function getRoutingTelemetryStatus(projectDir?: string): RoutingTelemetryStatus {
  if (projectDir !== undefined) {
    const config = loadProjectConfig(projectDir);
    if (config.telemetry?.routingDecisions !== undefined) {
      return {
        localRecordingEnabled: config.telemetry.routingDecisions,
      };
    }
  }

  const config = loadGlobalConfig();
  return {
    localRecordingEnabled: config.telemetry?.routingDecisions === true,
  };
}

export function enableRoutingTelemetry(projectDir?: string): RoutingTelemetryStatus {
  assertRoutingTelemetryNotEnvOverridden(projectDir);

  if (projectDir !== undefined) {
    const projectConfig = loadProjectConfig(projectDir);
    if (projectConfig.telemetry?.routingDecisions !== undefined) {
      saveProjectConfig(projectDir, {
        ...projectConfig,
        telemetry: {
          ...projectConfig.telemetry,
          routingDecisions: true,
        },
      });
      return { localRecordingEnabled: true };
    }
  }

  const config = loadGlobalConfig();
  saveGlobalConfig({
    ...config,
    telemetry: {
      ...config.telemetry,
      routingDecisions: true,
    },
  });
  return { localRecordingEnabled: true };
}

export function disableRoutingTelemetry(projectDir?: string): RoutingTelemetryStatus {
  assertRoutingTelemetryNotEnvOverridden(projectDir);

  if (projectDir !== undefined) {
    const projectConfig = loadProjectConfig(projectDir);
    if (projectConfig.telemetry?.routingDecisions !== undefined) {
      saveProjectConfig(projectDir, {
        ...projectConfig,
        telemetry: {
          ...projectConfig.telemetry,
          routingDecisions: false,
        },
      });
      return { localRecordingEnabled: false };
    }
  }

  const config = loadGlobalConfig();
  saveGlobalConfig({
    ...config,
    telemetry: {
      ...config.telemetry,
      routingDecisions: false,
    },
  });
  return { localRecordingEnabled: false };
}
