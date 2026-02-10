/**
 * CSV data source for arpeggio movements.
 *
 * Reads CSV files and returns data in batches for template expansion.
 * Handles quoted fields, escaped quotes, and various line endings.
 */

import { readFileSync } from 'node:fs';
import type { ArpeggioDataSource, DataBatch, DataRow } from './types.js';

/** Parse a CSV string into an array of string arrays (rows of fields) */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i]!;

    if (inQuotes) {
      if (char === '"') {
        // Check for escaped quote ("")
        if (i + 1 < content.length && content[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        // End of quoted field
        inQuotes = false;
        i++;
        continue;
      }
      currentField += char;
      i++;
      continue;
    }

    if (char === '"' && currentField.length === 0) {
      inQuotes = true;
      i++;
      continue;
    }

    if (char === ',') {
      currentRow.push(currentField);
      currentField = '';
      i++;
      continue;
    }

    if (char === '\r') {
      // Handle \r\n and bare \r
      currentRow.push(currentField);
      currentField = '';
      rows.push(currentRow);
      currentRow = [];
      if (i + 1 < content.length && content[i + 1] === '\n') {
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (char === '\n') {
      currentRow.push(currentField);
      currentField = '';
      rows.push(currentRow);
      currentRow = [];
      i++;
      continue;
    }

    currentField += char;
    i++;
  }

  // Handle last field/row
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}

/** Convert parsed CSV rows into DataRow objects using the header row */
function rowsToDataRows(headers: readonly string[], dataRows: readonly string[][]): DataRow[] {
  return dataRows.map((row) => {
    const dataRow: DataRow = {};
    for (let col = 0; col < headers.length; col++) {
      const header = headers[col]!;
      dataRow[header] = row[col] ?? '';
    }
    return dataRow;
  });
}

/** Split an array into chunks of the given size */
function chunk<T>(array: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export class CsvDataSource implements ArpeggioDataSource {
  constructor(private readonly filePath: string) {}

  async readBatches(batchSize: number): Promise<readonly DataBatch[]> {
    const content = readFileSync(this.filePath, 'utf-8');
    const parsed = parseCsv(content);

    if (parsed.length < 2) {
      throw new Error(`CSV file has no data rows: ${this.filePath}`);
    }

    const headers = parsed[0]!;
    const dataRowArrays = parsed.slice(1);
    const dataRows = rowsToDataRows(headers, dataRowArrays);
    const chunks = chunk(dataRows, batchSize);
    const totalBatches = chunks.length;

    return chunks.map((rows, index) => ({
      rows,
      batchIndex: index,
      totalBatches,
    }));
  }
}
