/**
 * Loop Health Monitor — public API
 *
 * Observes improvement loop health during piece execution.
 * Pure observer: never interferes with execution flow.
 */

export { FindingTracker } from './finding-tracker.js';
export {
  runHealthCheck,
  createDefaultThresholds,
  buildConversationAnalysisPrompt,
  parseAlignmentResponse,
  applyMisalignedVerdict,
} from './health-evaluator.js';
export { formatHealthReport } from './report-formatter.js';
