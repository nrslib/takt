/**
 * Merge processing for arpeggio batch results.
 *
 * Supports two merge strategies:
 * - 'concat': Simple concatenation with configurable separator
 * - 'custom': User-provided merge function (inline_js or file)
 */

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ArpeggioMergeMovementConfig, MergeFn } from './types.js';
import type { BatchResult } from './types.js';

const require = createRequire(import.meta.url);

function sortByBatchIndex(results: readonly BatchResult[]): readonly BatchResult[] {
  return results.slice().sort((a, b) => a.batchIndex - b.batchIndex);
}

/** Create a merge function from inline JS source */
function createCustomMergeFromInlineJs(inlineJs: string): MergeFn {
  const mergeImpl = new Function('results', inlineJs) as (results: readonly BatchResult[]) => unknown;

  return (results) => {
    const orderedResults = sortByBatchIndex(results);
    const value = mergeImpl(orderedResults);
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
}

/** Create a merge function from external JS module */
function createCustomMergeFromFile(path: string): MergeFn {
  const moduleExports = require(path);
  const mergeImpl = moduleExports?.default ?? moduleExports;

  if (typeof mergeImpl !== 'function') {
    throw new Error(`Custom merge module must export a function: ${path}`);
  }

  return (results) => {
    const orderedResults = sortByBatchIndex(results);
    const value = mergeImpl(orderedResults);
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
}

/** Create a concat merge function with the given separator */
function createConcatMerge(separator: string): MergeFn {
  return (results) =>
    sortByBatchIndex(results)
      .filter((r) => r.success)
      .map((r) => r.content)
      .join(separator);
}

/**
 * Build a merge function from the arpeggio merge configuration.
 */
export function buildMergeFn(config: ArpeggioMergeMovementConfig): MergeFn {
  if (config.strategy === 'custom') {
    if (config.inlineJs) {
      return createCustomMergeFromInlineJs(config.inlineJs);
    }
    if (config.file) {
      return createCustomMergeFromFile(config.file);
    }
    throw new Error('Custom merge strategy requires inline_js or file');
  }

  return createConcatMerge(config.separator ?? '\n');
}

/** Write merged output to a file if output_path is configured */
export function writeMergedOutput(outputPath: string, content: string): void {
  writeFileSync(outputPath, content, 'utf-8');
}
