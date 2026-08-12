export function invokeProvider(request) {
  return {
    traceLabel: request.traceLabel ?? null,
    timeoutMs: request.timeoutMs ?? 1000,
  };
}
