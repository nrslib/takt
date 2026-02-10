/**
 * Tests for the arpeggio data source factory.
 *
 * Covers:
 * - Built-in 'csv' source type returns CsvDataSource
 * - Custom module: valid default export returns a data source
 * - Custom module: non-function default export throws
 * - Custom module: missing default export throws
 */

import { describe, it, expect } from 'vitest';
import { createDataSource } from '../core/piece/arpeggio/data-source-factory.js';
import { CsvDataSource } from '../core/piece/arpeggio/csv-data-source.js';

describe('createDataSource', () => {
  it('should return a CsvDataSource for built-in "csv" type', async () => {
    const source = await createDataSource('csv', '/path/to/data.csv');
    expect(source).toBeInstanceOf(CsvDataSource);
  });

  it('should return a valid data source from a custom module with correct default export', async () => {
    const tempModulePath = new URL(
      'data:text/javascript,export default function(path) { return { readBatches: async () => [] }; }'
    ).href;

    const source = await createDataSource(tempModulePath, '/some/path');
    expect(source).toBeDefined();
    expect(typeof source.readBatches).toBe('function');
  });

  it('should throw when custom module does not export a default function', async () => {
    const tempModulePath = new URL(
      'data:text/javascript,export default "not-a-function"'
    ).href;

    await expect(createDataSource(tempModulePath, '/some/path')).rejects.toThrow(
      /must export a default factory function/
    );
  });

  it('should throw when custom module has no default export', async () => {
    const tempModulePath = new URL(
      'data:text/javascript,export const foo = 42'
    ).href;

    await expect(createDataSource(tempModulePath, '/some/path')).rejects.toThrow(
      /must export a default factory function/
    );
  });
});
