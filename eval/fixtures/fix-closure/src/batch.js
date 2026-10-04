export function emitBatch(emitter, entries) {
  return entries.map(({ report, context }) => {
    emitter.setActiveContext(context);
    return emitter.emit(report);
  });
}
