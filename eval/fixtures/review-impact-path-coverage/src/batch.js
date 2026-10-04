import { getActiveContext, setActiveContext } from './runtime-state.js';

export function emitBatch(emitter, items) {
  return items.map((item) => {
    setActiveContext(item.context);
    return emitter.emit(item.report, getActiveContext());
  });
}
