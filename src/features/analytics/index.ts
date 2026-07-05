/**
 * Analytics module — event collection and metrics.
 */

export type {
  AnalyticsEvent,
  ReviewFindingEvent,
  FixActionEvent,
  StepResultEvent,
  RoutingDecisionEvent,
} from './events.js';

export {
  initAnalyticsWriter,
  isAnalyticsEnabled,
  writeAnalyticsEvent,
  type AnalyticsWriterOptions,
} from './writer.js';

export {
  parseFindingsFromReport,
  buildReviewFindingEventsFromLedger,
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
