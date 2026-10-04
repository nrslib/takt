export const settings = Object.freeze({
  source: 'artifacts/source.json',
  documentLabel: 'document:{document_id}',
  indexPath: 'output/index.md',
  sections: Object.freeze([
    Object.freeze({ name: 'summary', order: 2 }),
    Object.freeze({ name: 'details', order: 1 }),
  ]),
});
