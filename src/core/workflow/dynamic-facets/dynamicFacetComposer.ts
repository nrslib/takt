import type {
  ResolvedFacetPool,
  ResolvedFacetContent,
} from '../../models/workflow-types.js';

export interface ComposedFacets {
  readonly policyContents: readonly string[];
  readonly knowledgeContents: readonly string[];
}

export interface FixedFacets {
  readonly policyContents: readonly ResolvedFacetContent[];
  readonly knowledgeContents: readonly ResolvedFacetContent[];
}

interface DynamicResource {
  readonly kind: 'policy' | 'knowledge';
  readonly index: number;
  readonly resolved: ResolvedFacetContent;
}

function collectDynamicResources(
  pool: ResolvedFacetPool,
  selectedIds: readonly string[],
): readonly DynamicResource[] {
  const selectedSet = new Set(selectedIds);
  const resources: DynamicResource[] = [];
  for (const candidate of pool.candidates) {
    if (!selectedSet.has(candidate.id)) continue;
    candidate.resolvedPolicyContents.forEach((resolved, index) => {
      resources.push({ kind: 'policy', index, resolved });
    });
    candidate.resolvedKnowledgeContents.forEach((resolved, index) => {
      resources.push({ kind: 'knowledge', index, resolved });
    });
  }
  return resources;
}

// Dedup follows order.md:251-252:
// - When both sides carry sourcePath, the same resource is detected by sourcePath and removed
//   in favor of the fixed side.
// - When neither side carries sourcePath (e.g. a bare-name ref resolved to ref-name content),
//   content comparison is used as the only available identity.
// - When only one side carries sourcePath, they are treated as distinct resources even if the
//   content coincidentally matches (order.md:252). No dedup happens across the two sides.
interface DedupIndex {
  /** sourcePaths of all entries that carry one. */
  readonly sourcePaths: Set<string>;
  /** contents of entries that DO NOT carry a sourcePath (content-based identity only). */
  readonly contentOnlyContents: Set<string>;
}

function buildDedupIndex(resources: readonly ResolvedFacetContent[]): DedupIndex {
  const sourcePaths = new Set<string>();
  const contentOnlyContents = new Set<string>();
  for (const r of resources) {
    if (r.sourcePath !== undefined) {
      sourcePaths.add(r.sourcePath);
    } else {
      contentOnlyContents.add(r.content);
    }
  }
  return { sourcePaths, contentOnlyContents };
}

function isDuplicate(index: DedupIndex, candidate: ResolvedFacetContent): boolean {
  if (candidate.sourcePath !== undefined) {
    return index.sourcePaths.has(candidate.sourcePath);
  }
  // Candidate lacks sourcePath: only dedup against entries that also lack sourcePath.
  return index.contentOnlyContents.has(candidate.content);
}

function addEntry(index: DedupIndex, entry: ResolvedFacetContent): void {
  if (entry.sourcePath !== undefined) {
    index.sourcePaths.add(entry.sourcePath);
  } else {
    index.contentOnlyContents.add(entry.content);
  }
}

export function composeDynamicFacets(
  pool: ResolvedFacetPool,
  selectedIds: readonly string[],
  fixed: FixedFacets,
): ComposedFacets {
  const dynamic = collectDynamicResources(pool, selectedIds);
  const policyContents = fixed.policyContents.map((r) => r.content);
  const knowledgeContents = fixed.knowledgeContents.map((r) => r.content);
  const seenPolicy = buildDedupIndex(fixed.policyContents);
  const seenKnowledge = buildDedupIndex(fixed.knowledgeContents);
  for (const resource of dynamic) {
    if (resource.kind === 'policy') {
      if (isDuplicate(seenPolicy, resource.resolved)) continue;
      addEntry(seenPolicy, resource.resolved);
      policyContents.push(resource.resolved.content);
    } else {
      if (isDuplicate(seenKnowledge, resource.resolved)) continue;
      addEntry(seenKnowledge, resource.resolved);
      knowledgeContents.push(resource.resolved.content);
    }
  }
  return {
    policyContents,
    knowledgeContents,
  };
}