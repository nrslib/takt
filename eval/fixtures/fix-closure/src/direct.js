export function emitDirect(emitter, report, context) {
  emitter.setActiveContext(context);
  return emitter.emit(report);
}
