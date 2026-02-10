/**
 * Merge processing for arpeggio batch results.
 *
 * Supports two merge strategies:
 * - 'concat': Simple concatenation with configurable separator
 * - 'custom': User-provided merge function (inline JS or external file)
 */

import { writeFileSync } from 'node:fs';
import type { ArpeggioMergeMovementConfig, BatchResult, MergeFn } from './types.js';

/** Create a concat merge function with the given separator */
function createConcatMerge(separator: string): MergeFn {
  return (results) =>
    results
      .filter((r) => r.success)
      .sort((a, b) => a.batchIndex - b.batchIndex)
      .map((r) => r.content)
      .join(separator);
}

/**
 * Create a merge function from inline JavaScript.
 *
 * The inline JS receives `results` as the function parameter (readonly BatchResult[]).
 * It must return a string.
 */
function createInlineJsMerge(jsBody: string): MergeFn {
  const fn = new Function('results', jsBody) as MergeFn;
  return (results) => {
    const output = fn(results);
    if (typeof output !== 'string') {
      throw new Error(`Inline JS merge function must return a string, got ${typeof output}`);
    }
    return output;
  };
}

/**
 * Create a merge function from an external JS file.
 *
 * The file must export a default function: (results: BatchResult[]) => string
 */
async function createFileMerge(filePath: string): Promise<MergeFn> {
  const module = await import(filePath) as { default?: MergeFn };
  if (typeof module.default !== 'function') {
    throw new Error(`Merge file "${filePath}" must export a default function`);
  }
  return module.default;
}

/**
 * Build a merge function from the arpeggio merge configuration.
 *
 * For 'concat' strategy: returns a simple join function.
 * For 'custom' strategy: loads from inline JS or external file.
 */
export async function buildMergeFn(config: ArpeggioMergeMovementConfig): Promise<MergeFn> {
  if (config.strategy === 'concat') {
    return createConcatMerge(config.separator ?? '\n');
  }

  // Custom strategy
  if (config.inlineJs) {
    return createInlineJsMerge(config.inlineJs);
  }

  if (config.filePath) {
    return createFileMerge(config.filePath);
  }

  throw new Error('Custom merge strategy requires either inline_js or file path');
}

/** Write merged output to a file if output_path is configured */
export function writeMergedOutput(outputPath: string, content: string): void {
  writeFileSync(outputPath, content, 'utf-8');
}
