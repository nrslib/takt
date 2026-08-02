import { getActiveContext } from './runtime-state.js';

export function recordReportAnalytics(report) {
  const context = getActiveContext();
  return { report, scope: context?.scope, iteration: context?.iteration };
}
