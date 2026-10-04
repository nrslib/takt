import { findPreviousOrderContent, findRunForTask } from './run-history.js';
import { summarizeRunReports } from './report-summary.js';

export function buildFailedInstructContext(task, runs, reportsBySlug) {
  const runSlug = task.runSlug ?? findRunForTask(runs, task.content);
  const reports = runSlug ? reportsBySlug[runSlug] ?? [] : [];
  return {
    runSlug,
    order: findPreviousOrderContent(runs, runSlug),
    reportSummary: summarizeRunReports(reports),
  };
}
