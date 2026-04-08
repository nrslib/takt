type PreviewCountConfig = Record<string, unknown>;

export function resolveAliasedPreviewCount(parsed: PreviewCountConfig): number | undefined {
  const stepValue = parsed.interactive_preview_steps;
  return typeof stepValue === 'number' ? stepValue : undefined;
}
