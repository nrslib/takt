import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { enumerateRawParallelSubSteps } from './workflowParallelTraversal.js';

export type RawRecord = Record<string, unknown>;

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__']);
const MAX_STEP_FRAGMENT_BYTES = 1024 * 1024;

interface StepFragmentConfigurationErrorOptions extends ErrorOptions {
  readonly path?: readonly PropertyKey[];
  readonly sourcePath?: string;
}

export class StepFragmentConfigurationError extends Error {
  readonly path?: readonly PropertyKey[];
  readonly sourcePath?: string;

  constructor(message: string, options?: StepFragmentConfigurationErrorOptions) {
    super(message, options);
    this.path = options?.path;
    this.sourcePath = options?.sourcePath;
  }
}

export function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPlainObject(value: unknown): value is RawRecord {
  return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function getOwnValue(record: RawRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function collectStepFragmentUses(value: unknown, refs = new Set<string>(), visited = new WeakSet<object>()): Set<string> {
  if (!isRecord(value)) return refs;
  if (visited.has(value)) throw new Error('Step fragment contains a circular YAML structure');
  visited.add(value);
  const uses = getOwnValue(value, 'uses');
  if (typeof uses === 'string') refs.add(uses);
  for (const { subStep } of enumerateRawParallelSubSteps(getOwnValue(value, 'parallel'), ['parallel'])) {
    collectStepFragmentUses(subStep, refs, visited);
  }
  visited.delete(value);
  return refs;
}

export function assertSafeStepFragmentObject(
  value: unknown,
  workflowPath: string,
  source: string,
  visited = new WeakSet<object>(),
): void {
  if (Array.isArray(value)) {
    if (visited.has(value)) throw workflowError(workflowPath, `${source} contains a circular YAML structure`);
    visited.add(value);
    for (const item of value) assertSafeStepFragmentObject(item, workflowPath, source, visited);
    visited.delete(value);
    return;
  }
  if (!isRecord(value)) return;
  if (visited.has(value)) throw workflowError(workflowPath, `${source} contains a circular YAML structure`);
  visited.add(value);
  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw workflowError(workflowPath, `${source} contains forbidden key "${key}"`);
    }
    assertSafeStepFragmentObject(nestedValue, workflowPath, source, visited);
  }
  visited.delete(value);
}

export function formatPropertyPath(path: readonly PropertyKey[]): string {
  return path.map((segment, index) => (
    typeof segment === 'number'
      ? `[${segment}]`
      : `${index === 0 ? '' : '.'}${String(segment)}`
  )).join('');
}

export function readStepFragment(path: string, workflowPath: string, ref: string): RawRecord {
  let fileDescriptor: number | undefined;
  let parsed: unknown;
  let failure: unknown;
  try {
    fileDescriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fileDescriptor);
    if (!stat.isFile()) throw workflowError(workflowPath, `step fragment "${ref}" at ${path} must be a regular file`);
    if (stat.size > MAX_STEP_FRAGMENT_BYTES) {
      throw workflowError(workflowPath, `step fragment "${ref}" at ${path} exceeds ${MAX_STEP_FRAGMENT_BYTES} bytes`);
    }
    const contentBuffer = Buffer.allocUnsafe(Math.min(stat.size, MAX_STEP_FRAGMENT_BYTES) + 1);
    let bytesRead = 0;
    while (bytesRead < contentBuffer.length) {
      const read = readSync(fileDescriptor, contentBuffer, bytesRead, contentBuffer.length - bytesRead, bytesRead);
      if (read === 0) break;
      bytesRead += read;
    }
    if (bytesRead > MAX_STEP_FRAGMENT_BYTES) {
      throw workflowError(workflowPath, `step fragment "${ref}" at ${path} exceeds ${MAX_STEP_FRAGMENT_BYTES} bytes`);
    }
    if (bytesRead > stat.size) {
      throw workflowError(workflowPath, `step fragment "${ref}" at ${path} changed size while being read`);
    }
    parsed = parseYaml(contentBuffer.toString('utf-8', 0, bytesRead));
  } catch (error) {
    failure = error;
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure !== undefined) {
    if (failure instanceof StepFragmentConfigurationError) {
      throw failure;
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    throw new StepFragmentConfigurationError(
      `Configuration error in workflow ${workflowPath}: failed to parse step fragment "${ref}" at ${path}: ${message}`,
      { cause: failure },
    );
  }
  if (!isPlainObject(parsed)) {
    throw workflowError(workflowPath, `step fragment "${ref}" at ${path} must contain one step object`);
  }
  assertSafeStepFragmentObject(parsed, workflowPath, `step fragment "${ref}" at ${path}`);
  return parsed;
}

export function workflowError(
  workflowPath: string,
  message: string,
  options?: StepFragmentConfigurationErrorOptions,
): Error {
  return new StepFragmentConfigurationError(
    `Configuration error in workflow ${workflowPath}: ${message}`,
    options,
  );
}
