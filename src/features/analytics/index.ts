/**
 * Analytics module — event collection and metrics.
 */

export type {
  AnalyticsEvent,
  ReviewFindingEvent,
  FixActionEvent,
  MovementResultEvent,
} from './events.js';

export {
  initAnalyticsWriter,
  isAnalyticsEnabled,
  writeAnalyticsEvent,
} from './writer.js';

export {
  parseFindingsFromReport,
  extractDecisionFromReport,
  inferSeverity,
  emitFixActionEvents,
  emitRebuttalEvents,
} from './report-parser.js';

export {
  computeReviewMetrics,
  formatReviewMetrics,
  parseSinceDuration,
  type ReviewMetrics,
} from './metrics.js';

export { purgeOldEvents } from './purge.js';
