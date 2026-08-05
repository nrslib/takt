import { describe, expect, it } from 'vitest';
import type { ResolvedFacetPool, ResolvedFacetPoolCandidate, ResolvedFacetContent } from '../core/models/workflow-types.js';
import { composeDynamicFacets } from '../core/workflow/dynamic-facets/dynamicFacetComposer.js';

interface CandidateInput {
  id: string;
  description: string;
  policy?: string | readonly string[];
  knowledge?: string | readonly string[];
}

function makeResolved(refs: readonly string[], facetContent: Record<string, string>, prefix: string): ResolvedFacetContent[] {
  return refs.map((r) => {
    const content = facetContent[r] ?? `${prefix}:${r}`;
    return { content, sourcePath: `${prefix}:${r}` };
  });
}

function fixedFacets(policyContents: readonly (string | ResolvedFacetContent)[], knowledgeContents: readonly (string | ResolvedFacetContent)[]): {
  policyContents: ResolvedFacetContent[];
  knowledgeContents: ResolvedFacetContent[];
} {
  const toResolved = (items: readonly (string | ResolvedFacetContent)[]): ResolvedFacetContent[] =>
    items.map((item) => typeof item === 'string' ? { content: item } : item);
  return {
    policyContents: toResolved(policyContents),
    knowledgeContents: toResolved(knowledgeContents),
  };
}

function makePool(candidates: readonly CandidateInput[], facetContent: Record<string, string>): ResolvedFacetPool {
  const resolvedCandidates: ResolvedFacetPoolCandidate[] = candidates.map((c) => {
    const policyRefs = typeof c.policy === 'string' ? [c.policy] : (c.policy ?? []);
    const knowledgeRefs = typeof c.knowledge === 'string' ? [c.knowledge] : (c.knowledge ?? []);
    return {
      id: c.id,
      description: c.description,
      policyRefs,
      knowledgeRefs,
      resolvedPolicyContents: makeResolved(policyRefs, facetContent, 'POLICY'),
      resolvedKnowledgeContents: makeResolved(knowledgeRefs, facetContent, 'KNOWLEDGE'),
    };
  });
  return {
    name: 'fix',
    candidates: resolvedCandidates,
  };
}

describe('DynamicFacetComposer (C-COMPOSE-ORDER, C-NO-DYNAMIC-OTHER)', () => {
  it('should place fixed facets first and dynamic facets after, in pool candidate definition order (C-COMPOSE-ORDER)', () => {
    const pool = makePool(
      [
        { id: 'backend', description: 'backend', knowledge: 'backend-api' },
        { id: 'transaction', description: 'transaction', policy: 'transaction-correctness', knowledge: 'database-transaction' },
        { id: 'backward-compatibility', description: 'compat', policy: 'backward-compatibility' },
      ],
      {},
    );
    const fixed = fixedFacets(['FIXED-POLICY-CODING'], ['FIXED-KNOWLEDGE-ARCHITECTURE']);
    // selector returns in reverse order; composer must use pool definition order
    const selectedIds = ['backward-compatibility', 'transaction'];

    const result = composeDynamicFacets(pool, selectedIds, fixed);

    expect(result.policyContents).toEqual([
      'FIXED-POLICY-CODING',
      'POLICY:transaction-correctness',
      'POLICY:backward-compatibility',
    ]);
    expect(result.knowledgeContents).toEqual([
      'FIXED-KNOWLEDGE-ARCHITECTURE',
      'KNOWLEDGE:database-transaction',
    ]);
  });

  it('should preserve facet order within a candidate (C-COMPOSE-ORDER: candidate 内記述順)', () => {
    const pool = makePool(
      [
        {
          id: 'bundle',
          description: 'bundle',
          policy: ['p-a', 'p-b'],
          knowledge: ['k-x', 'k-y'],
        },
      ],
      {},
    );
    const fixed = fixedFacets([], []);

    const result = composeDynamicFacets(pool, ['bundle'], fixed);

    expect(result.policyContents).toEqual(['POLICY:p-a', 'POLICY:p-b']);
    expect(result.knowledgeContents).toEqual(['KNOWLEDGE:k-x', 'KNOWLEDGE:k-y']);
  });

  it('should deduplicate the same resolved facet resource, preferring the fixed side (C-COMPOSE-ORDER: 重複除去・固定優先)', () => {
    // Both fixed and a dynamic candidate reference the same resource path "shared-policy".
    const pool = makePool(
      [
        { id: 'dup', description: 'dup', policy: 'shared-policy' },
      ],
      { 'shared-policy': 'SHARED-POLICY-CONTENT' },
    );
    const fixed = fixedFacets([{ content: 'SHARED-POLICY-CONTENT', sourcePath: 'POLICY:shared-policy' }], []);

    const result = composeDynamicFacets(pool, ['dup'], fixed);

    // The shared policy should appear only once, with the fixed one kept.
    expect(result.policyContents).toEqual(['SHARED-POLICY-CONTENT']);
  });

  it('should NOT treat content-identical but distinct resources as the same facet (C-COMPOSE-ORDER: 内容一致でも別 resource は同一扱いしない)', () => {
    // Two different resource paths that happen to have the same content string.
    const pool = makePool(
      [
        { id: 'dup', description: 'dup', policy: 'pool-policy' },
      ],
      { 'pool-policy': 'SAME-CONTENT' },
    );
    const fixed = fixedFacets([{ content: 'SAME-CONTENT', sourcePath: 'fixed-policy.md' }], []);

    const result = composeDynamicFacets(pool, ['dup'], fixed);

    // Both are kept because they are distinct resources despite identical content.
    expect(result.policyContents).toEqual(['SAME-CONTENT', 'SAME-CONTENT']);
  });

  it('should accept an empty selection (no dynamic facets added) and keep only fixed (C-COMPOSE-ORDER: 空選択)', () => {
    const pool = makePool(
      [
        { id: 'backend', description: 'backend', knowledge: 'backend-api' },
      ],
      {},
    );
    const fixed = fixedFacets(['FIXED-POLICY'], ['FIXED-KNOWLEDGE']);

    const result = composeDynamicFacets(pool, [], fixed);

    expect(result.policyContents).toEqual(['FIXED-POLICY']);
    expect(result.knowledgeContents).toEqual(['FIXED-KNOWLEDGE']);
  });

  it('should not include unselected candidate facets in the output (C-COMPOSE-ORDER: 未選択 facet を含めない)', () => {
    const pool = makePool(
      [
        { id: 'selected', description: 'selected', policy: 'selected-policy' },
        { id: 'unselected', description: 'unselected', knowledge: 'unselected-knowledge' },
      ],
      {},
    );
    const fixed = fixedFacets([], []);

    const result = composeDynamicFacets(pool, ['selected'], fixed);

    expect(result.policyContents).toEqual(['POLICY:selected-policy']);
    expect(result.knowledgeContents).toEqual([]);
  });

  it('should not change persona/instruction/provider/permission from dynamic facets (C-NO-DYNAMIC-OTHER)', () => {
    const pool = makePool(
      [
        { id: 'backend', description: 'backend', knowledge: 'backend-api' },
      ],
      {},
    );
    const fixed = fixedFacets([], []);
    const result = composeDynamicFacets(pool, ['backend'], fixed);

    // composeDynamicFacets returns only policyContents and knowledgeContents.
    // It must not return any field that could alter persona/instruction/provider/permission/MCP/tool/output contract.
    expect(Object.keys(result).sort()).toEqual(['knowledgeContents', 'policyContents']);
  });

  it('should deduplicate dynamic candidates sharing the same sourcePath (C-COMPOSE-ORDER: dynamic 同士の重複除去)', () => {
    const pool = makePool(
      [
        { id: 'a', description: 'a', policy: 'shared-policy' },
        { id: 'b', description: 'b', policy: 'shared-policy' },
      ],
      { 'shared-policy': 'SHARED' },
    );
    const fixed = fixedFacets([], []);

    const result = composeDynamicFacets(pool, ['a', 'b'], fixed);

    expect(result.policyContents).toEqual(['SHARED']);
  });

  it('should deduplicate sourcePath-less entries with identical content (C-COMPOSE-ORDER: sourcePath 無しの内容一致 dedup)', () => {
    const pool: ResolvedFacetPool = {
      name: 'fix',
      candidates: [
        {
          id: 'a',
          description: 'a',
          policyRefs: ['bare-a'],
          knowledgeRefs: [],
          resolvedPolicyContents: [{ content: 'BARE-CONTENT' }],
          resolvedKnowledgeContents: [],
        },
        {
          id: 'b',
          description: 'b',
          policyRefs: ['bare-b'],
          knowledgeRefs: [],
          resolvedPolicyContents: [{ content: 'BARE-CONTENT' }],
          resolvedKnowledgeContents: [],
        },
      ],
    };
    const fixed = fixedFacets([], []);

    const result = composeDynamicFacets(pool, ['a', 'b'], fixed);

    expect(result.policyContents).toEqual(['BARE-CONTENT']);
  });
});