import { CompanionReviewAuthority } from '../../core/workflow/companion/review-state-store.js';

declare const authority: CompanionReviewAuthority;

// @ts-expect-error Companion review state is mutable only through its store.
authority.states.clear();

// @ts-expect-error Companion review history is mutable only through its store.
authority.histories.clear();

// @ts-expect-error Companion review operations are mutable only through their store.
authority.operations.clear();
