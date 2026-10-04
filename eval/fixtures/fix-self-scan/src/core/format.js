// Formats run summary fragments for terminal output.
export function formatProviderLine(provider, model) {
  return model === undefined
    ? `provider: ${provider}`
    : `provider: ${provider} (model: ${model})`;
}

export function formatSourceLine(key, label) {
  return `${key}: ${label}`;
}

export function legacyFormatLine(parts) {
  return parts.filter((part) => part !== undefined).join(' / ');
}

export function indent(text, depth = 1) {
  const pad = '  '.repeat(depth);
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : pad + line))
    .join('\n');
}
