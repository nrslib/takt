export const definition = Object.freeze({
  selection: Object.freeze({
    role: 'reviewer',
    instruction: 'Choose matching entries.',
  }),
  workflow: Object.freeze({
    entry: 'root',
    calls: Object.freeze({
      root: Object.freeze(['child']),
      child: Object.freeze(['root']),
    }),
  }),
  monitor: Object.freeze({
    limit: 2,
    instruction: 'Inspect pass {count}.',
  }),
});
