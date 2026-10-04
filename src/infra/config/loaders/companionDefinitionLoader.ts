import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Language, ResolvedCompanionDefinition } from '../../../core/models/index.js';
import { MAX_COMPANION_INTERVAL_MS } from '../../../core/models/companion-types.js';
import { resolveNamedResourceWithSource } from './namedResourceResolver.js';
import { getBuiltinFacetDir } from '../paths.js';
import {
  resolveRefToContent,
  type FacetResolutionContext,
} from './resource-resolver.js';

const COMPANION_DEFINITION_EXTENSIONS = ['.yaml', '.yml'] as const;
const DEFAULT_COMPANION_INTERVAL_MS = 15_000;
const DEFAULT_COMPANION_INSTRUCTION = 'companion-watch-review';

const CompanionDefinitionSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  persona: z.string().trim().min(1).optional(),
  policy: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)]).optional(),
  knowledge: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)]).optional(),
  instruction: z.string().trim().min(1).optional(),
  interval_ms: z.number().int().positive().max(MAX_COMPANION_INTERVAL_MS).optional(),
}).strict();

export interface CompanionDefinitionDocument {
  readonly name: string;
  readonly description: string;
  readonly persona?: string;
  readonly policy?: string | string[];
  readonly knowledge?: string | string[];
  readonly instruction: string;
  readonly interval_ms?: number;
}

export function resolveCompanionDefinitionResource(
  name: string,
  candidateDirs: readonly string[],
): { readonly path: string; readonly candidateDir: string } | undefined {
  const resolved = resolveNamedResourceWithSource(name, {
    candidateDirs,
    extensions: COMPANION_DEFINITION_EXTENSIONS,
    rejectSymlinkedCandidateDirs: true,
  });
  return resolved === undefined
    ? undefined
    : { path: resolved.path, candidateDir: resolved.candidateDir };
}

export function parseCompanionDefinitionDocument(
  content: string,
  referenceName: string,
): CompanionDefinitionDocument {
  const parsed = CompanionDefinitionSchema.parse(parseYaml(content));
  if (parsed.name !== referenceName) {
    throw new Error(`Companion reference "${referenceName}" does not match declared name "${parsed.name}"`);
  }
  return {
    ...parsed,
    instruction: parsed.instruction ?? DEFAULT_COMPANION_INSTRUCTION,
  };
}

function asList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? [...value] : [value];
}

function facetDirectories(
  candidateDirs: readonly string[],
  kind: 'personas' | 'policies' | 'knowledge' | 'instructions',
  language: Language,
): string[] {
  return [
    ...candidateDirs.map((directory) => join(dirname(directory), 'facets', kind)),
    getBuiltinFacetDir(language, kind),
  ];
}

function loadFacet(
  name: string,
  candidateDirs: readonly string[],
  kind: 'personas' | 'policies' | 'knowledge' | 'instructions',
  language: Language,
): string {
  const resolved = resolveNamedResourceWithSource(name, {
    candidateDirs: facetDirectories(candidateDirs, kind, language),
    extensions: ['.md'],
    rejectSymlinkedCandidateDirs: true,
  });
  if (resolved === undefined) throw new Error(`Undefined companion ${kind} facet "${name}"`);
  return readFileSync(resolved.path, 'utf-8');
}

function resolveFacetContent(
  name: string,
  candidateDirs: readonly string[],
  kind: 'personas' | 'policies' | 'knowledge' | 'instructions',
  language: Language,
  context: FacetResolutionContext | undefined,
): string {
  if (context === undefined) return loadFacet(name, candidateDirs, kind, language);
  const workflowDir = context.workflowDir ?? context.projectDir ?? candidateDirs[0]!;
  const resolved = resolveRefToContent(name, undefined, workflowDir, kind, context);
  if (resolved === undefined) throw new Error(`Undefined companion ${kind} facet "${name}"`);
  return resolved;
}

export function loadCompanionDefinition(
  name: string,
  input: {
    candidateDirs: readonly string[];
    language: Language;
    facetContext?: FacetResolutionContext;
  },
): ResolvedCompanionDefinition {
  const resolved = resolveCompanionDefinitionResource(name, input.candidateDirs);
  if (!resolved) throw new Error(`Undefined companion "${name}"`);
  const parsed = parseCompanionDefinitionDocument(readFileSync(resolved.path, 'utf-8'), name);
  const policies = asList(parsed.policy);
  const knowledge = asList(parsed.knowledge);
  const instructionName = parsed.instruction;
  return {
    name,
    description: parsed.description,
    ...(parsed.persona === undefined ? {} : { persona: parsed.persona }),
    ...(parsed.persona === undefined
      ? {}
      : {
          personaContent: resolveFacetContent(
            parsed.persona,
            input.candidateDirs,
            'personas',
            input.language,
            input.facetContext,
          ),
        }),
    ...(policies === undefined
      ? {}
      : {
          policy: policies,
          policyContents: policies.map((policy) => resolveFacetContent(
            policy,
            input.candidateDirs,
            'policies',
            input.language,
            input.facetContext,
          )),
        }),
    ...(knowledge === undefined
      ? {}
      : {
          knowledge,
          knowledgeContents: knowledge.map((item) => resolveFacetContent(
            item,
            input.candidateDirs,
            'knowledge',
            input.language,
            input.facetContext,
          )),
        }),
    instruction: resolveFacetContent(
      instructionName,
      input.candidateDirs,
      'instructions',
      input.language,
      input.facetContext,
    ),
    instructionRef: instructionName,
    intervalMs: parsed.interval_ms ?? DEFAULT_COMPANION_INTERVAL_MS,
    sourcePath: resolved.path,
  };
}
