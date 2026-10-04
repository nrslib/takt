export function relayChildReport(emitter, parentContext, childEvent) {
  emitter.setActiveContext(parentContext);
  return emitter.emit(childEvent.report);
}
