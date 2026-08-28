export const schema = Object.freeze({
  dynamic_facets: Object.freeze({
    selector: Object.freeze({
      persona: 'dynamic facet selector',
      instruction: 'Select candidates whose tags match the current step.',
      source: 'facet_pool.candidates',
      input: 'step.tags',
    }),
  }),
  workflow: Object.freeze({
    entry: 'remediation-root',
    calls: Object.freeze({
      'remediation-root': Object.freeze(['review-child']),
      'review-child': Object.freeze(['remediation-root']),
    }),
  }),
  loop_monitor: Object.freeze({
    cycle: Object.freeze(['fix', 'fix-verifier', 'fix-retry']),
    threshold: 2,
    judge: Object.freeze({
      instruction: 'Judge whether fix-retry reached a terminal state at cycle {cycle_count}.',
    }),
  }),
});
