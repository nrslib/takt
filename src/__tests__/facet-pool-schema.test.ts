import { describe, expect, it } from 'vitest';
import { WorkflowConfigRawSchema } from '../core/models/workflow-schemas.js';

function baseWorkflowWithFacetPools(facetPools: unknown, steps: unknown[] = [
  {
    name: 'fix',
    persona: 'coder',
    policy: ['coding'],
    knowledge: ['architecture'],
    dynamic_facets: { pool: 'fix', max_selected: 4 },
    instruction: 'fix',
    edit: true,
    rules: [{ condition: 'done', next: 'COMPLETE' }],
  },
]): unknown {
  return {
    name: 'backend-fix',
    policies: {
      'transaction-correctness': '../facets/policies/transaction-correctness.md',
      'backward-compatibility': '../facets/policies/backward-compatibility.md',
      coding: '../facets/policies/coding.md',
    },
    knowledge: {
      'backend-api': '../facets/knowledge/backend-api.md',
      'database-transaction': '../facets/knowledge/database-transaction.md',
      architecture: '../facets/knowledge/architecture.md',
    },
    facet_pools: facetPools,
    steps,
    initial_step: 'fix',
    max_steps: 3,
  };
}

describe('facet_pools schema (C-CANDIDATE-SCHEMA, C-USES-INLINE-MIX, C-EXTERNAL-NESTED, C-LOAD-FAILFAST)', () => {
  describe('inline pool', () => {
    it('should accept an inline pool with scalar and array facet refs (C-CANDIDATE-SCHEMA, C-INLINE-POOL)', () => {
      const raw = baseWorkflowWithFacetPools({
        fix: {
          candidates: [
            { id: 'backend', description: 'API、repository、server-side実装を扱う', knowledge: 'backend-api' },
            {
              id: 'transaction',
              description: 'transaction境界、rollback、排他制御を扱う',
              policy: 'transaction-correctness',
              knowledge: 'database-transaction',
            },
            {
              id: 'backward-compatibility',
              description: '公開APIやschemaの互換性を維持する',
              policy: ['backward-compatibility'],
            },
          ],
        },
      });
      expect(() => WorkflowConfigRawSchema.parse(raw)).not.toThrow();
    });

    it('should accept a candidate that bundles multiple facets as arrays (C-CANDIDATE-SCHEMA bundle)', () => {
      const raw = baseWorkflowWithFacetPools({
        fix: {
          candidates: [
            {
              id: 'full-stack',
              description: 'bundle of policy and knowledge',
              policy: ['transaction-correctness', 'backward-compatibility'],
              knowledge: ['backend-api', 'database-transaction'],
            },
          ],
        },
      });
      expect(() => WorkflowConfigRawSchema.parse(raw)).not.toThrow();
    });

    it('should reject an empty pool (C-LOAD-FAILFAST: pool が空)', () => {
      const raw = baseWorkflowWithFacetPools({
        fix: { candidates: [] },
      });
      expect(() => WorkflowConfigRawSchema.parse(raw)).toThrow();
    });

    it('should reject a candidate with a duplicate id (C-LOAD-FAILFAST: candidate ID の重複)', () => {
      const raw = baseWorkflowWithFacetPools({
        fix: {
          candidates: [
            { id: 'backend', description: 'first', knowledge: 'backend-api' },
            { id: 'backend', description: 'duplicate', policy: 'transaction-correctness' },
          ],
        },
      });
      expect(() => WorkflowConfigRawSchema.parse(raw)).toThrow(/duplicate/i);
    });

    it('should reject a candidate with an empty id (C-CANDIDATE-SCHEMA: id は非空)', () => {
      const raw = baseWorkflowWithFacetPools({
        fix: {
          candidates: [
            { id: '', description: 'empty id', knowledge: 'backend-api' },
          ],
        },
      });
      expect(() => WorkflowConfigRawSchema.parse(raw)).toThrow();
    });

    it('should reject a candidate with an empty description (C-CANDIDATE-SCHEMA: description は非空)', () => {
      const raw = baseWorkflowWithFacetPools({
        fix: {
          candidates: [
            { id: 'backend', description: '', knowledge: 'backend-api' },
          ],
        },
      });
      expect(() => WorkflowConfigRawSchema.parse(raw)).toThrow();
    });

    it('should reject a candidate with neither policy nor knowledge (C-CANDIDATE-SCHEMA: 両方欠落)', () => {
      const raw = baseWorkflowWithFacetPools({
        fix: {
          candidates: [
            { id: 'noop', description: 'no facets' },
          ],
        },
      });
      expect(() => WorkflowConfigRawSchema.parse(raw)).toThrow();
    });

    it('should reject a candidate with an empty policy array (C-CANDIDATE-SCHEMA: 空配列)', () => {
      const raw = baseWorkflowWithFacetPools({
        fix: {
          candidates: [
            { id: 'backend', description: 'empty policy array', policy: [], knowledge: 'backend-api' },
          ],
        },
      });
      expect(() => WorkflowConfigRawSchema.parse(raw)).toThrow();
    });

    it('should reject a candidate with an empty knowledge array (C-CANDIDATE-SCHEMA: 空配列)', () => {
      const raw = baseWorkflowWithFacetPools({
        fix: {
          candidates: [
            { id: 'backend', description: 'empty knowledge array', policy: 'coding', knowledge: [] },
          ],
        },
      });
      expect(() => WorkflowConfigRawSchema.parse(raw)).toThrow();
    });
  });

  describe('external pool (uses)', () => {
    it('should accept an external pool with uses (C-EXTERNAL-POOL)', () => {
      const raw = baseWorkflowWithFacetPools({
        fix: { uses: 'implementation-fix' },
      });
      expect(() => WorkflowConfigRawSchema.parse(raw)).not.toThrow();
    });

    it('should reject mixing uses with inline candidates (C-USES-INLINE-MIX)', () => {
      const raw = baseWorkflowWithFacetPools({
        fix: {
          uses: 'implementation-fix',
          candidates: [
            { id: 'backend', description: 'inline candidate', knowledge: 'backend-api' },
          ],
        },
      });
      expect(() => WorkflowConfigRawSchema.parse(raw)).toThrow();
    });

    it('should reject mixing uses with inline policies (C-USES-INLINE-MIX)', () => {
      const raw = baseWorkflowWithFacetPools({
        fix: {
          uses: 'implementation-fix',
          policies: { 'transaction-correctness': '../facets/policies/transaction-correctness.md' },
        },
      });
      expect(() => WorkflowConfigRawSchema.parse(raw)).toThrow();
    });

    it('should reject mixing uses with inline knowledge (C-USES-INLINE-MIX)', () => {
      const raw = baseWorkflowWithFacetPools({
        fix: {
          uses: 'implementation-fix',
          knowledge: { 'backend-api': '../facets/knowledge/backend-api.md' },
        },
      });
      expect(() => WorkflowConfigRawSchema.parse(raw)).toThrow();
    });
  });

  describe('dynamic_facets on step', () => {
    it('should accept dynamic_facets on a normal agent step', () => {
      const raw = baseWorkflowWithFacetPools(
        { fix: { uses: 'implementation-fix' } },
        [{
          name: 'fix',
          persona: 'coder',
          policy: ['coding'],
          knowledge: ['architecture'],
          dynamic_facets: { pool: 'fix', max_selected: 4 },
          instruction: 'fix',
          edit: true,
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        }],
      );
      expect(() => WorkflowConfigRawSchema.parse(raw)).not.toThrow();
    });

    it('should reject dynamic_facets on a workflow_call step (C-LOAD-FAILFAST: 通常 agent step 以外)', () => {
      const raw = baseWorkflowWithFacetPools(
        { fix: { uses: 'implementation-fix' } },
        [{
          name: 'callstep',
          call: 'called',
          dynamic_facets: { pool: 'fix', max_selected: 4 },
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        }],
      );
      expect(() => WorkflowConfigRawSchema.parse(raw)).toThrow();
    });

    it('should reject dynamic_facets on a parallel parent step (C-LOAD-FAILFAST: 通常 agent step 以外)', () => {
      const raw = baseWorkflowWithFacetPools(
        { fix: { uses: 'implementation-fix' } },
        [{
          name: 'parallel-parent',
          parallel: [
            { name: 'child', instruction: 'child', rules: [{ condition: 'done', next: 'COMPLETE' }] },
          ],
          dynamic_facets: { pool: 'fix', max_selected: 4 },
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        }],
      );
      expect(() => WorkflowConfigRawSchema.parse(raw)).toThrow();
    });

    it('should reject max_selected of 0 (C-LOAD-FAILFAST: max_selected が不正)', () => {
      const raw = baseWorkflowWithFacetPools(
        { fix: { uses: 'implementation-fix' } },
        [{
          name: 'fix',
          persona: 'coder',
          policy: ['coding'],
          dynamic_facets: { pool: 'fix', max_selected: 0 },
          instruction: 'fix',
          edit: true,
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        }],
      );
      expect(() => WorkflowConfigRawSchema.parse(raw)).toThrow();
    });
  });
});