export const REVIEW_MODE_VALUES = ['initial', 'follow_up', 'unspecified'] as const;

export type ReviewMode = (typeof REVIEW_MODE_VALUES)[number];

export function isReviewMode(value: unknown): value is ReviewMode {
  return typeof value === 'string' && REVIEW_MODE_VALUES.some((candidate) => candidate === value);
}
