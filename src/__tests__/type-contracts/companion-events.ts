import type { CompanionEventEmitter } from '../../core/workflow/companion/event-publisher.js';

declare const emitCompanionEvent: CompanionEventEmitter;

emitCompanionEvent('companion:start', {
  step: 'implement',
  companion: 'security-reviewer',
});

emitCompanionEvent('companion:pool_selected', {
  step: 'implement',
  selected: ['security-reviewer'],
  rationale: 'Relevant change',
});

emitCompanionEvent('companion:finding', {
  step: 'implement',
  companion: 'security-reviewer',
  findingId: 'security-reviewer-1',
  severity: 'must_fix',
});

emitCompanionEvent('companion:fix_round', {
  step: 'implement',
  sequence: 2,
  openMustFixCount: 1,
});

emitCompanionEvent('companion:complete', {
  step: 'implement',
  openMustFixCount: 0,
  escalated: false,
});

emitCompanionEvent('companion:complete', {
  step: 'implement',
  openMustFixCount: 0,
  escalated: false,
  // @ts-expect-error Companion completion events do not expose error details.
  error: 'private detail',
});

// @ts-expect-error Companion finding events require their declared payload.
emitCompanionEvent('companion:finding', {
  step: 'implement',
  companion: 'security-reviewer',
});

// @ts-expect-error Companion events require exactly one declared payload.
emitCompanionEvent('companion:start');

// @ts-expect-error Undeclared companion event names are rejected.
emitCompanionEvent('companion:error', { step: 'implement' });
