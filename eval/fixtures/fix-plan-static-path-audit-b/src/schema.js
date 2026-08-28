export const schema = Object.freeze({
  output_contracts: Object.freeze({
    report: Object.freeze([
      Object.freeze({ name: 'summary', order: 2 }),
      Object.freeze({ name: 'findings', order: 1 }),
    ]),
  }),
  arpeggio: Object.freeze({
    source_path: 'artifacts/source.json',
    template: 'reports/{report_id}.md',
    merge: Object.freeze({ file: 'reports/index.md' }),
  }),
});
