import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod/v4';
import type { FacetResolutionContext } from './resource-resolver.js';
import { ExternalFacetPoolFileRawSchema, type ExternalFacetPoolFileRaw } from './facetPoolSchema.js';
import { resolveFacetPoolResource, buildFacetPoolLookupDirs } from './facetPoolLookupDirectories.js';

export interface ResolvedExternalFacetPoolResource {
  readonly raw: ExternalFacetPoolFileRaw;
  readonly path: string;
  readonly sourceDir: string;
  readonly candidateDir: string;
  readonly candidateDirs: readonly string[];
}

export function loadExternalFacetPoolFile(
  ref: string,
  context: FacetResolutionContext | undefined,
  options: {
    candidateDirs?: readonly string[];
    scopedCandidateDirs?: ReadonlyMap<string, readonly string[]>;
  } = {},
): ResolvedExternalFacetPoolResource {
  if (!context) {
    throw new Error(`Configuration error: facet pool "${ref}" requires workflow loader context`);
  }
  const resolved = resolveFacetPoolResource(ref, context, options);
  if (!resolved) {
    throw new Error(
      `Configuration error: facet pool "${ref}" could not be resolved (searched: ${JSON.stringify(buildFacetPoolLookupDirs(context))})`,
    );
  }
  const content = readFileSync(resolved.path, 'utf-8');
  const parsed: unknown = parseYaml(content);
  let pool: ExternalFacetPoolFileRaw;
  try {
    pool = ExternalFacetPoolFileRawSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Configuration error: facet pool file "${resolved.path}" is invalid: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  return {
    raw: pool,
    path: resolved.path,
    sourceDir: dirname(resolved.path),
    candidateDir: resolved.candidateDir,
    candidateDirs: resolved.candidateDirs,
  };
}