export const schema = Object.freeze({
  companion: Object.freeze({
    direct: Object.freeze({
      name: 'audit-companion',
      entry: 'runDirect',
    }),
    companion_ref: Object.freeze({
      defaults: Object.freeze({
        task: 'default-task',
        previous_response: 'no-previous-response',
      }),
      args: Object.freeze(['task', 'previous_response']),
    }),
  }),
  capabilities: Object.freeze({
    workflow: Object.freeze(['read', 'write', 'review']),
    normal: Object.freeze(['read', 'review']),
    parallel: Object.freeze(['read']),
  }),
  repertoires: Object.freeze({
    packages: Object.freeze({
      '@takt/core': Object.freeze({
        facets: Object.freeze({ audit: 'core audit facet' }),
      }),
      '@takt/extended': Object.freeze({
        facets: Object.freeze({ audit: 'extended audit facet' }),
      }),
    }),
  }),
});
