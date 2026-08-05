import { dirname } from 'node:path';
import { resolveSectionMapWithSource, type FacetResolutionContext, type ResolvedSectionMap, type WorkflowSections } from './resource-resolver.js';
import { resolveRefToContentWithSource } from './resource-resolver.js';
import type { ResolvedFacetPool, ResolvedFacetPoolCandidate, ResolvedFacetContent } from '../../../core/models/workflow-types.js';
import { loadExternalFacetPoolFile, type ResolvedExternalFacetPoolResource } from './facetPoolResourceResolver.js';

interface InlinePoolInput {
  readonly kind: 'inline';
  readonly name: string;
  readonly policies: Record<string, string> | undefined;
  readonly knowledge: Record<string, string> | undefined;
  readonly candidates: readonly {
    readonly id: string;
    readonly description: string;
    readonly policy?: string | readonly string[];
    readonly knowledge?: string | readonly string[];
  }[];
}

interface ExternalPoolInput {
  readonly kind: 'external';
  readonly name: string;
  readonly ref: string;
}

function normalizeRefs(refs: string | readonly string[] | undefined): readonly string[] {
  if (refs === undefined) return [];
  if (typeof refs === 'string') return [refs];
  return refs;
}

interface ResolvedSections {
  readonly policies: ResolvedSectionMap | undefined;
  readonly knowledge: ResolvedSectionMap | undefined;
}

function buildResolvedSections(
  policies: Record<string, string> | undefined,
  knowledge: Record<string, string> | undefined,
  baseDir: string,
  context: FacetResolutionContext | undefined,
  trustedRoot?: string,
): ResolvedSections {
  return {
    policies: resolveSectionMapWithSource(policies, baseDir, 'policies', context, trustedRoot),
    knowledge: resolveSectionMapWithSource(knowledge, baseDir, 'knowledge', context, trustedRoot),
  };
}

function mergeResolvedSections(
  poolSections: ResolvedSections,
  workflowSections: WorkflowSections | undefined,
): ResolvedSections {
  if (workflowSections === undefined) return poolSections;
  const mergeMap = (
    poolMap: ResolvedSectionMap | undefined,
    workflowMap: ResolvedSectionMap | undefined,
  ): ResolvedSectionMap | undefined => {
    if (workflowMap === undefined) return poolMap;
    if (poolMap === undefined) return workflowMap;
    // Pool side takes priority on key collision.
    return { ...workflowMap, ...poolMap };
  };
  return {
    policies: mergeMap(poolSections.policies, workflowSections.resolvedPoliciesWithSource),
    knowledge: mergeMap(poolSections.knowledge, workflowSections.resolvedKnowledgeWithSource),
  };
}

function resolveCandidate(
  candidate: InlinePoolInput['candidates'][number],
  sections: ResolvedSections,
  baseDir: string,
  context: FacetResolutionContext | undefined,
  resolveOptions?: { readonly strictBareName?: boolean; readonly trustedRoot?: string },
): ResolvedFacetPoolCandidate {
  const policyRefs = normalizeRefs(candidate.policy);
  const knowledgeRefs = normalizeRefs(candidate.knowledge);
  const resolvedPolicyContents: ResolvedFacetContent[] = policyRefs.map((ref) => {
    const resolved = resolveRefToContentWithSource(ref, sections.policies, baseDir, 'policies', context, resolveOptions);
    if (resolved === undefined) {
      throw new Error(
        `Configuration error: facet pool candidate "${candidate.id}" references unknown policy "${ref}"`,
      );
    }
    return { content: resolved.content, ...(resolved.sourcePath === undefined ? {} : { sourcePath: resolved.sourcePath }) };
  });
  const resolvedKnowledgeContents: ResolvedFacetContent[] = knowledgeRefs.map((ref) => {
    const resolved = resolveRefToContentWithSource(ref, sections.knowledge, baseDir, 'knowledge', context, resolveOptions);
    if (resolved === undefined) {
      throw new Error(
        `Configuration error: facet pool candidate "${candidate.id}" references unknown knowledge "${ref}"`,
      );
    }
    return { content: resolved.content, ...(resolved.sourcePath === undefined ? {} : { sourcePath: resolved.sourcePath }) };
  });
  return {
    id: candidate.id,
    description: candidate.description,
    policyRefs,
    knowledgeRefs,
    resolvedPolicyContents,
    resolvedKnowledgeContents,
  };
}

function compileInlinePool(
  input: InlinePoolInput,
  baseDir: string,
  context: FacetResolutionContext | undefined,
  workflowSections: WorkflowSections | undefined,
): ResolvedFacetPool {
  const poolSections = buildResolvedSections(input.policies, input.knowledge, baseDir, context);
  // Inline pool candidates use the workflow-local facet namespace: alias and bare facet lookup
  // must resolve against the workflow's resolved section maps. Pool-side aliases win on collision.
  const sections = mergeResolvedSections(poolSections, workflowSections);
  const candidates = input.candidates.map((candidate) =>
    resolveCandidate(candidate, sections, baseDir, context),
  );
  return {
    name: input.name,
    source: 'inline',
    candidates,
  };
}

function compileExternalPool(
  input: ExternalPoolInput,
  context: FacetResolutionContext | undefined,
  options: {
    candidateDirs?: readonly string[];
    scopedCandidateDirs?: ReadonlyMap<string, readonly string[]>;
  },
): ResolvedFacetPool {
  if (!context) {
    throw new Error(`Configuration error: facet pool "${input.ref}" requires workflow loader context`);
  }
  const resource: ResolvedExternalFacetPoolResource = loadExternalFacetPoolFile(input.ref, context, options);
  const pool = resource.raw;
  const trustedRoot = dirname(resource.candidateDir);
  const sections = buildResolvedSections(pool.policies, pool.knowledge, resource.sourceDir, undefined, trustedRoot);
  const candidates = pool.candidates.map((candidate) =>
    resolveCandidate(candidate, sections, resource.sourceDir, undefined, { strictBareName: true, trustedRoot }),
  );
  return {
    name: input.name,
    source: 'external',
    candidates,
  };
}

export type FacetPoolCompilationInput = InlinePoolInput | ExternalPoolInput;

export function compileFacetPool(
  input: FacetPoolCompilationInput,
  baseDir: string,
  context: FacetResolutionContext | undefined,
  options: {
    candidateDirs?: readonly string[];
    scopedCandidateDirs?: ReadonlyMap<string, readonly string[]>;
    workflowSections?: WorkflowSections;
  } = {},
): ResolvedFacetPool {
  if (input.kind === 'inline') {
    return compileInlinePool(input, baseDir, context, options.workflowSections);
  }
  return compileExternalPool(input, context, options);
}

export function buildResolvedFacetPoolDependencies(
  input: FacetPoolCompilationInput,
  context: FacetResolutionContext | undefined,
  options: {
    candidateDirs?: readonly string[];
    scopedCandidateDirs?: ReadonlyMap<string, readonly string[]>;
  } = {},
): readonly string[] {
  if (input.kind === 'inline') {
    return [];
  }
  const resource = loadExternalFacetPoolFile(input.ref, context, options);
  return [resource.path];
}