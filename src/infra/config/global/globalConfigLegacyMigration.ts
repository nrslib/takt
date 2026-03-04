function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

const FORBIDDEN_CONFIG_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function sanitizeConfigValue(value: unknown, path: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeConfigValue(item, `${path}[${index}]`));
  }

  const record = getRecord(value);
  if (!record) {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(record)) {
    if (FORBIDDEN_CONFIG_KEYS.has(key)) {
      throw new Error(`Configuration error: forbidden key "${key}" at "${path}".`);
    }
    sanitized[key] = sanitizeConfigValue(nestedValue, `${path}.${key}`);
  }
  return sanitized;
}

type LegacyGlobalConfigMigrationResult = {
  migratedConfig: Record<string, unknown>;
  migratedLogLevel?: string;
};

export function migrateDeprecatedGlobalConfigKeys(rawConfig: Record<string, unknown>): LegacyGlobalConfigMigrationResult {
  const migratedConfig: Record<string, unknown> = { ...rawConfig };
  const hasLegacyLogLevel = Object.prototype.hasOwnProperty.call(rawConfig, 'log_level');
  const legacyLogLevel = rawConfig.log_level;
  const hasLegacyObservability = Object.prototype.hasOwnProperty.call(rawConfig, 'observability');
  const observability = getRecord(rawConfig.observability);
  const initialLogging = getRecord(rawConfig.logging);
  let migratedLogging = initialLogging ? { ...initialLogging } : undefined;

  if (hasLegacyObservability) {
    console.warn('Deprecated: "observability" is deprecated. Use "logging" instead.');
    if (observability) {
      const observabilityProviderEvents = observability.provider_events;
      if (observabilityProviderEvents !== undefined) {
        const hasExplicitProviderEvents = migratedLogging
          ? Object.prototype.hasOwnProperty.call(migratedLogging, 'provider_events')
          : false;
        if (!hasExplicitProviderEvents) {
          migratedLogging = {
            ...(migratedLogging ?? {}),
            provider_events: observabilityProviderEvents,
          };
        }
      }
    }
  }

  if (hasLegacyLogLevel) {
    console.warn('Deprecated: "log_level" is deprecated. Use "logging.level" instead.');
  }

  const resolvedLoggingLevel = migratedLogging?.level;
  const migratedLogLevel = typeof resolvedLoggingLevel === 'string'
    ? resolvedLoggingLevel
    : hasLegacyLogLevel && typeof legacyLogLevel === 'string'
      ? legacyLogLevel
      : undefined;

  if (migratedLogLevel !== undefined) {
    const hasExplicitLevel = migratedLogging
      ? Object.prototype.hasOwnProperty.call(migratedLogging, 'level')
      : false;
    if (!hasExplicitLevel) {
      migratedLogging = {
        ...(migratedLogging ?? {}),
        level: migratedLogLevel,
      };
    }
  }
  if (migratedLogging) {
    migratedConfig.logging = migratedLogging;
  }

  if (hasLegacyObservability) {
    delete migratedConfig.observability;
  }
  if (hasLegacyLogLevel) {
    delete migratedConfig.log_level;
  }

  return {
    migratedConfig,
    migratedLogLevel,
  };
}
