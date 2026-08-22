const DEPRECATED_GHERKIN_KEY = 'gherkin';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function omitDeprecatedAssistantGherkin(
  rawConfig: Record<string, unknown>,
): { config: Record<string, unknown>; ignored: boolean } {
  const assistant = rawConfig.assistant;
  if (!isRecord(assistant) || !Object.hasOwn(assistant, DEPRECATED_GHERKIN_KEY)) {
    return { config: rawConfig, ignored: false };
  }

  const currentAssistant = Object.fromEntries(
    Object.entries(assistant).filter(([key]) => key !== DEPRECATED_GHERKIN_KEY),
  );
  return {
    config: { ...rawConfig, assistant: currentAssistant },
    ignored: true,
  };
}

export function warnDeprecatedAssistantGherkin(): void {
  process.emitWarning(
    'assistant.gherkin is deprecated and ignored. Gherkin is always enabled; use assistant.formal_spec for Alloy and Quint guidance.',
    { code: 'TAKT_DEPRECATED_CONFIG' },
  );
}
