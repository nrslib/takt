import { getActiveContext, setActiveContext } from './runtime-state.js';

export function prepareParallel(emitter, items) {
  return items.map((item) => {
    setActiveContext(item.context);
    return () => emitter.emit(item.report, getActiveContext());
  });
}
