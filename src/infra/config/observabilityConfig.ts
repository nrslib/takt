import type {
  ObservabilityConfig,
  ResolvedObservabilityConfig,
} from '../../core/models/config-types.js';

type RawObservabilityConfig = {
  enabled?: boolean;
  monitor?: boolean;
  session_log_exporter?: boolean;
  usage_events_phase?: boolean;
};

export const DISABLED_OBSERVABILITY_CONFIG: ResolvedObservabilityConfig = {
  enabled: false,
  monitor: false,
  sessionLogExporter: false,
  usageEventsPhase: false,
};

export function normalizeObservabilityConfig(
  raw: RawObservabilityConfig | undefined,
): ObservabilityConfig | undefined {
  if (!raw) {
    return undefined;
  }

  const config: ObservabilityConfig = {
    enabled: raw.enabled,
    monitor: raw.monitor,
    sessionLogExporter: raw.session_log_exporter,
    usageEventsPhase: raw.usage_events_phase,
  };

  return hasObservabilityField(config) ? config : undefined;
}

export function denormalizeObservabilityConfig(
  config: ObservabilityConfig | undefined,
): Record<string, unknown> | undefined {
  if (!config) {
    return undefined;
  }

  const raw: Record<string, unknown> = {};
  if (config.enabled !== undefined) raw.enabled = config.enabled;
  if (config.monitor !== undefined) raw.monitor = config.monitor;
  if (config.sessionLogExporter !== undefined) raw.session_log_exporter = config.sessionLogExporter;
  if (config.usageEventsPhase !== undefined) raw.usage_events_phase = config.usageEventsPhase;

  return Object.keys(raw).length > 0 ? raw : undefined;
}

export function resolveObservabilityConfig(
  project: ObservabilityConfig | undefined,
  global: ObservabilityConfig | undefined,
): ResolvedObservabilityConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? DISABLED_OBSERVABILITY_CONFIG.enabled,
    monitor: project?.monitor ?? global?.monitor ?? DISABLED_OBSERVABILITY_CONFIG.monitor,
    sessionLogExporter: project?.sessionLogExporter
      ?? global?.sessionLogExporter
      ?? DISABLED_OBSERVABILITY_CONFIG.sessionLogExporter,
    usageEventsPhase: project?.usageEventsPhase
      ?? global?.usageEventsPhase
      ?? DISABLED_OBSERVABILITY_CONFIG.usageEventsPhase,
  };
}

function hasObservabilityField(config: ObservabilityConfig): boolean {
  return config.enabled !== undefined
    || config.monitor !== undefined
    || config.sessionLogExporter !== undefined
    || config.usageEventsPhase !== undefined;
}
