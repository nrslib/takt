import { catalogRow } from './catalog-row.js';

export function listNode(node) {
  return JSON.stringify(catalogRow(node));
}
