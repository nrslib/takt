export const OPERATION_STATES = Object.freeze([
  'prepared',
  'dispatching',
  'response_recorded',
  'applied',
  'failed',
  'unknown_after_dispatch',
  'cancelled',
] as const);

export type OperationState = (typeof OPERATION_STATES)[number];

export const OPERATION_TRANSITION_CONTRACT = Object.freeze({
  prepared: Object.freeze(['dispatching', 'failed', 'cancelled']),
  dispatching: Object.freeze(['response_recorded', 'failed', 'unknown_after_dispatch']),
  response_recorded: Object.freeze(['applied', 'failed']),
  applied: Object.freeze([]),
  failed: Object.freeze([]),
  unknown_after_dispatch: Object.freeze([]),
  cancelled: Object.freeze([]),
} satisfies Readonly<Record<OperationState, readonly OperationState[]>>);

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const OPERATION_STATES_SQL = quoted(OPERATION_STATES);

export const OPERATION_TRANSITIONS_SQL = Object.entries(
  OPERATION_TRANSITION_CONTRACT,
).filter(([, next]) => next.length > 0).map(([from, next]) => (
  `(from_state = '${from}' AND to_state IN (${quoted(next)}))`
)).join('\n      OR ');

export const OPERATION_UPDATE_TRANSITIONS_SQL = Object.entries(
  OPERATION_TRANSITION_CONTRACT,
).filter(([, next]) => next.length > 0).map(([from, next]) => (
  `(OLD.state = '${from}' AND NEW.state IN (${quoted(next)}))`
)).join('\n      OR ');

export const OPERATION_NEW_TRANSITIONS_SQL = Object.entries(
  OPERATION_TRANSITION_CONTRACT,
).filter(([, next]) => next.length > 0).map(([from, next]) => (
  `(NEW.from_state = '${from}' AND NEW.to_state IN (${quoted(next)}))`
)).join('\n      OR ');
