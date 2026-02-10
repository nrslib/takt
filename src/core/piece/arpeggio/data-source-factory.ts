/**
 * Factory for creating data source instances.
 *
 * Maps source type names to their implementations.
 * Built-in: 'csv'. Users can extend with custom JS modules.
 */

import type { ArpeggioDataSource } from './types.js';
import { CsvDataSource } from './csv-data-source.js';

/** Built-in data source type mapping */
const BUILTIN_SOURCES: Record<string, (path: string) => ArpeggioDataSource> = {
  csv: (path) => new CsvDataSource(path),
};

/**
 * Create a data source instance by type and path.
 *
 * For built-in types ('csv'), uses the registered factory.
 * For custom types, loads from the source type as a JS module path.
 */
export async function createDataSource(
  sourceType: string,
  sourcePath: string,
): Promise<ArpeggioDataSource> {
  const builtinFactory = BUILTIN_SOURCES[sourceType];
  if (builtinFactory) {
    return builtinFactory(sourcePath);
  }

  // Custom data source: sourceType is a path to a JS module that exports a factory
  const module = await import(sourceType) as {
    default?: (path: string) => ArpeggioDataSource;
  };
  if (typeof module.default !== 'function') {
    throw new Error(
      `Custom data source module "${sourceType}" must export a default factory function`
    );
  }
  return module.default(sourcePath);
}
