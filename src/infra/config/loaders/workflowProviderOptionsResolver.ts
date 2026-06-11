import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod/v4';
import { StepProviderOptionsObjectSchema } from '../../../core/models/schema-base.js';
import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import { mergeProviderOptions, normalizeProviderOptions } from '../providerOptions.js';

type RawWorkflowProviderOptions = Record<string, unknown> & {
  $ref?: string;
};

interface ResolvedProviderOptionsRefPath {
  path: string;
  realPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function removeProviderOptionsRef(raw: RawWorkflowProviderOptions): Record<string, unknown> | undefined {
  const inline = { ...raw };
  delete inline.$ref;
  return Object.keys(inline).length > 0 ? inline : undefined;
}

const ProviderOptionsWithRefSchema = StepProviderOptionsObjectSchema.extend({
  $ref: z.string().min(1).optional(),
});

function isPathInsideDirectory(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function resolveProviderOptionsRefPath(
  ref: string,
  currentDir: string,
  rootDir: string,
): ResolvedProviderOptionsRefPath {
  if (isAbsolute(ref)) {
    throw new Error(`Configuration error: provider_options.$ref must be a relative path inside the workflow directory: ${ref}`);
  }

  const refPath = resolve(currentDir, ref);
  const resolvedRootDir = resolve(rootDir);
  if (!isPathInsideDirectory(refPath, resolvedRootDir)) {
    throw new Error(`Configuration error: provider_options.$ref must stay inside the workflow directory: ${ref}`);
  }

  if (!existsSync(refPath)) {
    throw new Error(`Configuration error: provider_options.$ref not found: ${ref}`);
  }

  const realRootDir = realpathSync(rootDir);
  const realRefPath = realpathSync(refPath);
  if (!isPathInsideDirectory(realRefPath, realRootDir)) {
    throw new Error(`Configuration error: provider_options.$ref must stay inside the workflow directory: ${ref}`);
  }

  return { path: refPath, realPath: realRefPath };
}

export function resolveWorkflowProviderOptions(
  raw: RawWorkflowProviderOptions | undefined,
  workflowDir: string,
): StepProviderOptions | undefined {
  return resolveWorkflowProviderOptionsFromDir(raw, workflowDir, workflowDir, new Set<string>());
}

function resolveWorkflowProviderOptionsFromDir(
  raw: RawWorkflowProviderOptions | undefined,
  currentDir: string,
  rootDir: string,
  seenRefs: Set<string>,
): StepProviderOptions | undefined {
  if (!raw) {
    return undefined;
  }

  const parsedRaw = ProviderOptionsWithRefSchema.parse(raw) as RawWorkflowProviderOptions;
  const ref = parsedRaw.$ref;
  if (ref === undefined) {
    return normalizeProviderOptions(parsedRaw);
  }

  const refPath = resolveProviderOptionsRefPath(ref, currentDir, rootDir);
  if (seenRefs.has(refPath.realPath)) {
    throw new Error(`Configuration error: provider_options.$ref contains a circular reference: ${ref}`);
  }

  const referencedRaw = parseYaml(readFileSync(refPath.path, 'utf-8'));
  if (!isRecord(referencedRaw)) {
    throw new Error(`Configuration error: provider_options.$ref must point to a YAML object: ${ref}`);
  }
  const parsedReferencedRaw = ProviderOptionsWithRefSchema.parse(referencedRaw) as RawWorkflowProviderOptions;

  const nextSeenRefs = new Set(seenRefs);
  nextSeenRefs.add(refPath.realPath);
  const referencedOptions = resolveWorkflowProviderOptionsFromDir(
    parsedReferencedRaw,
    dirname(refPath.path),
    rootDir,
    nextSeenRefs,
  );
  const inlineOptions = normalizeProviderOptions(removeProviderOptionsRef(parsedRaw));
  return mergeProviderOptions(referencedOptions, inlineOptions);
}
