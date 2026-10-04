export function buildRequest(options) {
  if (options.traceLabel === undefined) {
    return {};
  }

  return { traceLabel: options.traceLabel };
}
