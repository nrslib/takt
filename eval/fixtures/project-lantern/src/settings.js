export const settings = Object.freeze({
  source: 'artifacts/source.json',
  documentPath: 'documents/{document_id}.md',
  indexPath: 'output/index.md',
  sections: Object.freeze([
    Object.freeze({ name: 'summary', order: 2 }),
    Object.freeze({ name: 'details', order: 1 }),
  ]),
});
