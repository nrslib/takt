import { evaluateMonitor } from './evaluate-monitor.js';
import { findCycle } from './find-cycle.js';
import { loadDefinition } from './load-definition.js';
import { selectEntries } from './select-entries.js';

export function buildExecutionPlan(input) {
  const current = loadDefinition();
  return {
    selection: selectEntries(current.selection, input),
    cycle: findCycle(current.workflow),
    monitor: evaluateMonitor(current.monitor, input.count),
  };
}
