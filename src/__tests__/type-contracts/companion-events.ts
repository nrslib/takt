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

emitCompanionEvent('companion:review_round', {
  step: 'implement',
  companion: 'security-reviewer',
  trigger: 'quiet',
  digest: 'digest-1',
  changedLines: 12,
  findingCount: 1,
  reviewerFindings: [],
  reviewerUpdates: [],
  acceptedFindings: [],
  acceptedUpdates: [],
});

emitCompanionEvent('companion:queue_coalesced', {
  step: 'implement',
  companion: 'security-reviewer',
  replaced: {
    trigger: 'quiet',
    digest: 'digest-1',
    changedLines: 10,
    observedGeneration: 1,
  },
  replacement: {
    trigger: 'quiet',
    digest: 'digest-2',
    changedLines: 12,
    observedGeneration: 2,
  },
});

emitCompanionEvent('companion:review_round', {
  step: 'implement',
  companion: 'security-reviewer',
  // @ts-expect-error Companion review rounds require a declared trigger value.
  trigger: 'manual',
  digest: 'digest-1',
  changedLines: 12,
  findingCount: 1,
  reviewerFindings: [],
  reviewerUpdates: [],
  acceptedFindings: [],
  acceptedUpdates: [],
});

// @ts-expect-error Companion queue coalescing requires the replacement payload.
emitCompanionEvent('companion:queue_coalesced', {
  step: 'implement',
  companion: 'security-reviewer',
  replaced: {
    trigger: 'quiet',
    digest: 'digest-1',
    changedLines: 10,
    observedGeneration: 1,
  },
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
