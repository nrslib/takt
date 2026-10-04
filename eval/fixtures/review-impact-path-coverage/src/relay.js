export function relayChildReport(emitter, parentContext, childEvent) {
  return emitter.emit(childEvent.report, parentContext);
}
