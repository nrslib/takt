/**
 * Template expansion for arpeggio movements.
 *
 * Expands placeholders in prompt templates using data from batches:
 * - {line:N} — entire row N as "key: value" pairs (1-based)
 * - {col:N:name} — specific column value from row N (1-based)
 * - {batch_index} — 0-based batch index
 * - {total_batches} — total number of batches
 */

import { readFileSync } from 'node:fs';
import type { DataBatch, DataRow } from './types.js';

/** Format a single data row as "key: value" lines */
function formatRow(row: DataRow): string {
  return Object.entries(row)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

/**
 * Expand placeholders in a template string using batch data.
 *
 * Supported placeholders:
 * - {line:N} — Row N (1-based) formatted as "key: value" lines
 * - {col:N:name} — Column "name" from row N (1-based)
 * - {batch_index} — 0-based batch index
 * - {total_batches} — Total number of batches
 */
export function expandTemplate(template: string, batch: DataBatch): string {
  let result = template;

  // Replace {batch_index} and {total_batches}
  result = result.replace(/\{batch_index\}/g, String(batch.batchIndex));
  result = result.replace(/\{total_batches\}/g, String(batch.totalBatches));

  // Replace {col:N:name} — must be done before {line:N} to avoid partial matches
  result = result.replace(/\{col:(\d+):(\w+)\}/g, (_match, indexStr: string, colName: string) => {
    const rowIndex = parseInt(indexStr, 10) - 1;
    if (rowIndex < 0 || rowIndex >= batch.rows.length) {
      throw new Error(
        `Template placeholder {col:${indexStr}:${colName}} references row ${indexStr} but batch has ${batch.rows.length} rows`
      );
    }
    const row = batch.rows[rowIndex]!;
    const value = row[colName];
    if (value === undefined) {
      throw new Error(
        `Template placeholder {col:${indexStr}:${colName}} references unknown column "${colName}"`
      );
    }
    return value;
  });

  // Replace {line:N}
  result = result.replace(/\{line:(\d+)\}/g, (_match, indexStr: string) => {
    const rowIndex = parseInt(indexStr, 10) - 1;
    if (rowIndex < 0 || rowIndex >= batch.rows.length) {
      throw new Error(
        `Template placeholder {line:${indexStr}} references row ${indexStr} but batch has ${batch.rows.length} rows`
      );
    }
    return formatRow(batch.rows[rowIndex]!);
  });

  return result;
}

/** Load a template file and return its content */
export function loadTemplate(templatePath: string): string {
  return readFileSync(templatePath, 'utf-8');
}
