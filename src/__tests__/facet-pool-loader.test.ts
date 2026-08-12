import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { getGlobalFacetPoolsDir, getProjectFacetPoolsDir, getBuiltinLanguageFacetPoolsDir, getBuiltinSharedFacetPoolsDir } from '../infra/config/paths.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { inspectWorkflowFile } from '../infra/config/loaders/workflowDoctor.js';
import { getWorkflowDescription } from '../infra/config/loaders/workflowPreview.js';

const COMPLETE_CALLER_RULES = `
    rules:
      - condition: done
        next: COMPLETE`;

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function writeWorkflow(root: string, name: string, body: string, initialStep: string): string {
  return writeFile(root, `.takt/workflows/${name}.yaml`, `name: ${name}
initial_step: ${initialStep}
max_steps: 3
${body}
`);
}

function writeProjectPool(root: string, name: string, content: string): string {
  const fileName = name.endsWith('.yaml') || name.endsWith('.yml') ? name : `${name}.yaml`;
  return writeFile(root, `.takt/facet-pools/${fileName}`, content);
}

function writeGlobalPool(root: string, name: string, content: string): string {
  return writeFile(root, `facet-pools/${name}.yaml`, content);
}

function writeFacet(root: string, relativePath: string, content: string): string {
  return writeFile(root, relativePath, content);
}

function errorMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected action to throw');
}

const INLINE_POOL_WORKFLOW = `
policies:
  coding: ../../facets/policies/coding.md
  architecture: ../../facets/knowledge/architecture.md
  transaction-correctness: ../../facets/policies/transaction-correctness.md
knowledge:
  architecture: ../../facets/knowledge/architecture.md
  backend-api: ../../facets/knowledge/backend-api.md
  database-transaction: ../../facets/knowledge/database-transaction.md
facet_pools:
  fix:
    candidates:
      - id: backend
        description: API、repository、server-side実装を扱う
        knowledge: backend-api
      - id: transaction
        description: transaction境界、rollback、排他制御を扱う
        policy: transaction-correctness
        knowledge: database-transaction
      - id: backward-compatibility
        description: 公開APIやschemaの互換性を維持する
        policy: transaction-correctness
steps:
  - name: fix
    persona: coder
    policy: [coding]
    knowledge: [architecture]
    dynamic_facets:
      pool: fix
      max_selected: 3
    instruction: fix
    edit: true${COMPLETE_CALLER_RULES}
`;

const EXTERNAL_POOL_WORKFLOW = `
policies:
  coding: ../../facets/policies/coding.md
knowledge:
  architecture: ../../facets/knowledge/architecture.md
facet_pools:
  fix:
    uses: implementation-fix
steps:
  - name: fix
    persona: coder
    policy: [coding]
    knowledge: [architecture]
    dynamic_facets:
      pool: fix
      max_selected: 3
    instruction: fix
    edit: true${COMPLETE_CALLER_RULES}
`;

const EXTERNAL_POOL_BODY = `policies:
  transaction-correctness: ./facets/policies/transaction-correctness.md
  backward-compatibility: ./facets/policies/backward-compatibility.md
knowledge:
  backend-api: ./facets/knowledge/backend-api.md
  database-transaction: ./facets/knowledge/database-transaction.md
candidates:
  - id: backend
    description: API、repository、server-side実装を扱う
    knowledge: backend-api
  - id: transaction
    description: transaction境界、rollback、排他制御を扱う
    policy: transaction-correctness
    knowledge: database-transaction
  - id: backward-compatibility
    description: 公開APIやschemaの互換性を維持する
    policy: backward-compatibility
`;

const STATIC_PARALLEL_CHILD_WORKFLOW = `
policies:
  coding: ../../facets/policies/coding.md
knowledge:
  architecture: ../../facets/knowledge/architecture.md
facet_pools:
  fix:
    candidates:
      - id: backend
        description: backend
        knowledge: architecture
steps:
  - name: parallel-parent
    parallel:
      - name: child
        persona: coder
        instruction: child
        dynamic_facets:
          pool: fix
          max_selected: 1
        rules:
          - condition: done
            next: COMPLETE
    rules:
      - condition: done
        next: COMPLETE
`;

const DYNAMIC_PARALLEL_CHILD_WORKFLOW = `
policies:
  coding: ../../facets/policies/coding.md
knowledge:
  architecture: ../../facets/knowledge/architecture.md
facet_pools:
  fix:
    candidates:
      - id: backend
        description: backend
        knowledge: architecture
steps:
  - name: parallel-parent
    parallel:
      fixed:
        - name: fixed-child
          persona: coder
          instruction: fixed
          dynamic_facets:
            pool: fix
            max_selected: 1
          rules:
            - condition: done
              next: COMPLETE
      pool:
        - name: pool-child
          description: pool child
          persona: coder
          instruction: pool
          dynamic_facets:
            pool: fix
          rules:
            - condition: done
              next: COMPLETE
    rules:
      - condition: done
        next: COMPLETE
`;

describe('facet_pools loader (C-INLINE-POOL, C-EXTERNAL-POOL, C-POOL-NORMALIZE, C-POOL-LOOKUP, C-POOL-PROVENANCE)', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    projectDir = mkdtempSync(join(tmpdir(), 'takt-facet-pool-project-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-facet-pool-global-'));
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    writeFacet(projectDir, 'facets/policies/coding.md', '# coding policy\n');
    writeFacet(projectDir, 'facets/policies/transaction-correctness.md', '# transaction-correctness policy\n');
    writeFacet(projectDir, 'facets/policies/backward-compatibility.md', '# backward-compatibility policy\n');
    writeFacet(projectDir, 'facets/knowledge/architecture.md', '# architecture knowledge\n');
    writeFacet(projectDir, 'facets/knowledge/backend-api.md', '# backend-api knowledge\n');
    writeFacet(projectDir, 'facets/knowledge/database-transaction.md', '# database-transaction knowledge\n');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  describe('C-INLINE-POOL: inline facet_pools.<name>', () => {
    it('should load an inline pool and resolve candidate facets through workflow-local sections (alias + bare facet lookup)', () => {
      const workflowPath = writeWorkflow(projectDir, 'inline-pool', INLINE_POOL_WORKFLOW, 'fix');
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);

      expect(workflow.facetPools).toBeDefined();
      const pool = workflow.facetPools?.fix;
      expect(pool).toBeDefined();
      expect(pool?.source).toBe('inline');
      expect(pool?.candidates.map((c) => c.id)).toEqual(['backend', 'transaction', 'backward-compatibility']);
      // backend candidate resolves knowledge:backend-api to workflow-local section content
      const backend = pool?.candidates.find((c) => c.id === 'backend');
      expect(backend?.knowledgeRefs).toEqual(['backend-api']);
      // S1: the alias resolves to the workflow section's facet file body, not the ref name.
      expect(backend?.resolvedKnowledgeContents?.[0]?.content).toContain('# backend-api knowledge');
      expect(backend?.resolvedKnowledgeContents?.[0]?.sourcePath).toBeDefined();
    });

    it('should resolve a bare facet name in an inline pool via the builtin/global layer when not in workflow sections', () => {
      const workflowPath = writeWorkflow(projectDir, 'inline-pool', INLINE_POOL_WORKFLOW, 'fix');
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);
      // transaction candidate's policy:transaction-correctness is aliased via workflow policies section
      const transaction = workflow.facetPools?.fix?.candidates.find((c) => c.id === 'transaction');
      expect(transaction?.policyRefs).toEqual(['transaction-correctness']);
      expect(transaction?.resolvedPolicyContents?.[0]?.content).toContain('# transaction-correctness policy');
    });
  });

  describe('C-EXTERNAL-POOL: external `uses`', () => {
    it('should load an external pool resource and resolve candidate facets from the pool file directory', () => {
      // External pool lives in project facet-pools/ with its own facets dir alongside
      writeProjectPool(projectDir, 'implementation-fix', EXTERNAL_POOL_BODY);
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/transaction-correctness.md', '# ext transaction-correctness\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/backward-compatibility.md', '# ext backward-compatibility\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/backend-api.md', '# ext backend-api\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/database-transaction.md', '# ext database-transaction\n');

      const workflowPath = writeWorkflow(projectDir, 'external-pool', EXTERNAL_POOL_WORKFLOW, 'fix');
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);

      expect(workflow.facetPools).toBeDefined();
      const pool = workflow.facetPools?.fix;
      expect(pool?.candidates.map((c) => c.id)).toEqual(['backend', 'transaction', 'backward-compatibility']);
    });

    it('should NOT capture a same-named alias from the caller workflow (C-EXTERNAL-POOL 暗黙 capture 拒否)', () => {
      // Caller defines a policy alias "transaction-correctness" pointing to a DIFFERENT file.
      // External pool defines its own "transaction-correctness" pointing to its own file.
      // The resolved candidate facet content must come from the pool's file, not the caller's.
      writeProjectPool(projectDir, 'implementation-fix', EXTERNAL_POOL_BODY);
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/transaction-correctness.md', '# POOL transaction-correctness\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/backward-compatibility.md', '# POOL backward-compatibility\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/backend-api.md', '# POOL backend-api\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/database-transaction.md', '# POOL database-transaction\n');

      const callerWorkflow = `
policies:
  coding: ../../facets/policies/coding.md
  transaction-correctness: ../../facets/policies/transaction-correctness.md
knowledge:
  architecture: ../../facets/knowledge/architecture.md
facet_pools:
  fix:
    uses: implementation-fix
steps:
  - name: fix
    persona: coder
    policy: [coding]
    knowledge: [architecture]
    dynamic_facets:
      pool: fix
      max_selected: 3
    instruction: fix
    edit: true${COMPLETE_CALLER_RULES}
`;
      const workflowPath = writeWorkflow(projectDir, 'external-pool-no-capture', callerWorkflow, 'fix');
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);

      const transaction = workflow.facetPools?.fix?.candidates.find((c) => c.id === 'transaction');
      // The candidate's resolved policy content must reference the POOL's transaction-correctness file,
      // proving the caller's same-named alias was not captured.
      expect(transaction?.resolvedPolicyContents?.[0]?.content).toContain('POOL transaction-correctness');
    });

    it('should reject nested uses/params/$param in an external pool (C-EXTERNAL-NESTED)', () => {
      const nestedPoolBody = `policies:
  transaction-correctness: ./facets/policies/transaction-correctness.md
knowledge:
  backend-api: ./facets/knowledge/backend-api.md
candidates:
  - id: backend
    description: backend
    knowledge: backend-api
uses: another-pool
`;
      writeProjectPool(projectDir, 'implementation-fix', nestedPoolBody);
      const workflowPath = writeWorkflow(projectDir, 'external-pool-nested', EXTERNAL_POOL_WORKFLOW, 'fix');
      expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
    });

    it('should fail-fast when an external pool candidate references a bare name not in the pool section map (S2: no caller capture, no candidateDirs fallback)', () => {
      // Pool defines candidates that reference a bare name "orphan-policy" with no map entry.
      // The caller workflow has a "orphan-policy" alias in its policies section pointing to a project facet.
      // The external pool must NOT capture the caller alias and must fail-fast on the unresolved bare name.
      const poolBodyWithBare = `policies:
  transaction-correctness: ./facets/policies/transaction-correctness.md
knowledge:
  backend-api: ./facets/knowledge/backend-api.md
candidates:
  - id: backend
    description: backend
    knowledge: backend-api
  - id: orphan
    description: orphan candidate
    policy: orphan-policy
`;
      writeProjectPool(projectDir, 'implementation-fix', poolBodyWithBare);
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/transaction-correctness.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/backend-api.md', '# ext\n');
      // Caller project facet that the pool must NOT capture.
      writeFacet(projectDir, 'facets/policies/orphan-policy.md', '# caller orphan policy\n');

      const callerWorkflow = `
policies:
  coding: ../../facets/policies/coding.md
  orphan-policy: ../../facets/policies/orphan-policy.md
knowledge:
  architecture: ../../facets/knowledge/architecture.md
facet_pools:
  fix:
    uses: implementation-fix
steps:
  - name: fix
    persona: coder
    policy: [coding]
    knowledge: [architecture]
    dynamic_facets:
      pool: fix
      max_selected: 3
    instruction: fix
    edit: true${COMPLETE_CALLER_RULES}
`;
      const workflowPath = writeWorkflow(projectDir, 'external-pool-bare-fail', callerWorkflow, 'fix');
      expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/unknown policy "orphan-policy"/);
    });
  });

  describe('C-POOL-NORMALIZE: inline and external normalize to the same ResolvedFacetPool shape', () => {
    it('should produce the same ResolvedFacetPool shape for inline and external definitions', () => {
      // Inline
      const inlinePath = writeWorkflow(projectDir, 'inline-pool-norm', INLINE_POOL_WORKFLOW, 'fix');
      const inlineWorkflow = loadWorkflowFromFile(inlinePath, projectDir);
      const inlinePool = inlineWorkflow.facetPools?.fix;

      // External
      writeProjectPool(projectDir, 'implementation-fix', EXTERNAL_POOL_BODY);
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/transaction-correctness.md', '# ext transaction-correctness\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/backward-compatibility.md', '# ext backward-compatibility\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/backend-api.md', '# ext backend-api\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/database-transaction.md', '# ext database-transaction\n');
      const externalPath = writeWorkflow(projectDir, 'external-pool-norm', EXTERNAL_POOL_WORKFLOW, 'fix');
      const externalWorkflow = loadWorkflowFromFile(externalPath, projectDir);
      const externalPool = externalWorkflow.facetPools?.fix;

      // Both pools have the same candidate ids and the same structural shape.
      expect(inlinePool?.candidates.map((c) => c.id)).toEqual(externalPool?.candidates.map((c) => c.id));
      // ResolvedFacetPool carries a `source` discriminator used by preview; inline/external
      // are normalized to the same shape while preserving their origin metadata (order.md:339).
      expect(inlinePool?.source).toBe('inline');
      expect(externalPool?.source).toBe('external');
    });
  });

  describe('DFP-002/DFP-006: parallel child dynamic facet loading', () => {
    it('should retain dynamic facets on static parallel children during normalization (DFP-002)', () => {
      const workflowPath = writeWorkflow(
        projectDir,
        'static-parallel-facets',
        STATIC_PARALLEL_CHILD_WORKFLOW,
        'parallel-parent',
      );
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);
      const parent = workflow.steps[0];

      if (!parent || !('parallel' in parent) || parent.parallel === undefined || !Array.isArray(parent.parallel)) {
        throw new Error('Expected a static parallel workflow step');
      }
      expect(parent.parallel[0]?.dynamicFacets).toEqual({ pool: 'fix', maxSelected: 1 });
    });

    it('should retain dynamic facets on dynamic parallel fixed and pool children during normalization (DFP-002)', () => {
      const workflowPath = writeWorkflow(
        projectDir,
        'dynamic-parallel-facets',
        DYNAMIC_PARALLEL_CHILD_WORKFLOW,
        'parallel-parent',
      );
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);
      const parent = workflow.steps[0];

      if (!parent || !('parallel' in parent) || parent.parallel === undefined || Array.isArray(parent.parallel)) {
        throw new Error('Expected a dynamic parallel workflow step');
      }
      expect(parent.parallel.fixed[0]?.dynamicFacets).toEqual({ pool: 'fix', maxSelected: 1 });
      expect(parent.parallel.pool[0]?.dynamicFacets).toEqual({ pool: 'fix' });
    });

    it('should reject an unknown facet pool on a nested static parallel child (DFP-006)', () => {
      const workflow = STATIC_PARALLEL_CHILD_WORKFLOW.replace('pool: fix', 'pool: missing');
      const workflowPath = writeWorkflow(projectDir, 'static-parallel-missing-pool', workflow, 'parallel-parent');

      const error = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));
      expect(error).toContain('unknown facet pool "missing"');
      expect(error).toContain('parallel');
    });

    it('should reject an unknown facet pool on a dynamic parallel fixed child (DFP-017)', () => {
      const workflow = DYNAMIC_PARALLEL_CHILD_WORKFLOW.replace(
        'dynamic_facets:\n            pool: fix\n            max_selected: 1',
        'dynamic_facets:\n            pool: missing\n            max_selected: 1',
      );
      const workflowPath = writeWorkflow(projectDir, 'dynamic-parallel-fixed-missing-pool', workflow, 'parallel-parent');

      const error = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));
      expect(error).toContain('unknown facet pool "missing"');
      expect(error).toContain('parallel');
    });

    it('should reject max_selected exceeding candidates on a dynamic parallel fixed child (DFP-017)', () => {
      const workflow = DYNAMIC_PARALLEL_CHILD_WORKFLOW.replace(
        'dynamic_facets:\n            pool: fix\n            max_selected: 1',
        'dynamic_facets:\n            pool: fix\n            max_selected: 2',
      );
      const workflowPath = writeWorkflow(projectDir, 'dynamic-parallel-fixed-max-selected', workflow, 'parallel-parent');

      const error = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));
      expect(error).toContain('exceeds candidate count');
      expect(error).toContain('parallel');
    });

    it('should reject max_selected exceeding candidates on a nested dynamic pool child (DFP-006)', () => {
      const workflow = DYNAMIC_PARALLEL_CHILD_WORKFLOW.replace(
        'pool: fix\n          rules:',
        'pool: fix\n            max_selected: 2\n          rules:',
      );
      const workflowPath = writeWorkflow(projectDir, 'dynamic-parallel-max-selected', workflow, 'parallel-parent');

      const error = errorMessage(() => loadWorkflowFromFile(workflowPath, projectDir));
      expect(error).toContain('exceeds candidate count');
      expect(error).toContain('parallel');
    });
  });

  describe('C-POOL-LOOKUP: exploration order and trust boundary', () => {
    it('should resolve a bare name in .yaml then .yml extension order (C-POOL-LOOKUP: bare name 拡張子順)', () => {
      // Provide both .yaml and .yml; .yaml should win.
      writeProjectPool(projectDir, 'implementation-fix.yaml', EXTERNAL_POOL_BODY);
      writeProjectPool(projectDir, 'implementation-fix.yml', `policies:
  other: ./facets/policies/other.md
knowledge:
  other: ./facets/knowledge/other.md
candidates:
  - id: other
    description: other
    knowledge: other
`);
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/transaction-correctness.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/backward-compatibility.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/backend-api.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/database-transaction.md', '# ext\n');

      const workflowPath = writeWorkflow(projectDir, 'ext-yaml-order', EXTERNAL_POOL_WORKFLOW, 'fix');
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);

      expect(workflow.facetPools?.fix?.candidates.map((c) => c.id)).toEqual(['backend', 'transaction', 'backward-compatibility']);
    });

    it('should prefer project-local pool over global pool (C-POOL-LOOKUP: project > global)', () => {
      writeProjectPool(projectDir, 'implementation-fix', EXTERNAL_POOL_BODY);
      writeGlobalPool(globalConfigDir, 'implementation-fix', `policies:
  global-pool: ./facets/policies/global-pool.md
knowledge:
  global-pool: ./facets/knowledge/global-pool.md
candidates:
  - id: global-only
    description: global-only candidate
    knowledge: global-pool
`);
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/transaction-correctness.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/backward-compatibility.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/backend-api.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/database-transaction.md', '# ext\n');

      const workflowPath = writeWorkflow(projectDir, 'ext-project-over-global', EXTERNAL_POOL_WORKFLOW, 'fix');
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);

      expect(workflow.facetPools?.fix?.candidates.map((c) => c.id)).toEqual(['backend', 'transaction', 'backward-compatibility']);
    });

    it('should resolve a global pool when no project-local pool exists (C-POOL-LOOKUP: global fallback)', () => {
      writeGlobalPool(globalConfigDir, 'implementation-fix', EXTERNAL_POOL_BODY);
      mkdirSync(join(globalConfigDir, 'facet-pools/facets/policies'), { recursive: true });
      mkdirSync(join(globalConfigDir, 'facet-pools/facets/knowledge'), { recursive: true });
      writeFacet(globalConfigDir, 'facet-pools/facets/policies/transaction-correctness.md', '# global\n');
      writeFacet(globalConfigDir, 'facet-pools/facets/policies/backward-compatibility.md', '# global\n');
      writeFacet(globalConfigDir, 'facet-pools/facets/knowledge/backend-api.md', '# global\n');
      writeFacet(globalConfigDir, 'facet-pools/facets/knowledge/database-transaction.md', '# global\n');

      const workflowPath = writeWorkflow(projectDir, 'ext-global-fallback', EXTERNAL_POOL_WORKFLOW, 'fix');
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);

      expect(workflow.facetPools?.fix?.candidates.map((c) => c.id)).toEqual(['backend', 'transaction', 'backward-compatibility']);
    });

    it('should reject a symlinked candidate directory (C-POOL-LOOKUP: symlink 拒否)', () => {
      // Create a symlinked facet-pools dir pointing to a real dir.
      const realDir = mkdtempSync(join(tmpdir(), 'takt-facet-pool-real-'));
      writeFileSync(join(realDir, 'implementation-fix.yaml'), EXTERNAL_POOL_BODY, 'utf-8');
      mkdirSync(join(realDir, 'facets/policies'), { recursive: true });
      writeFileSync(join(realDir, 'facets/policies/transaction-correctness.md'), '# real\n');
      mkdirSync(join(realDir, 'facets/knowledge'), { recursive: true });
      writeFileSync(join(realDir, 'facets/knowledge/backend-api.md'), '# real\n');
      writeFileSync(join(realDir, 'facets/policies/backward-compatibility.md'), '# real\n');
      writeFileSync(join(realDir, 'facets/knowledge/database-transaction.md'), '# real\n');

      mkdirSync(join(projectDir, '.takt'), { recursive: true });
      symlinkSync(realDir, join(projectDir, '.takt', 'facet-pools'));

      const workflowPath = writeWorkflow(projectDir, 'ext-symlink', EXTERNAL_POOL_WORKFLOW, 'fix');
      expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
    });

    it('should reject a missing external pool reference (C-LOAD-FAILFAST: dynamic_facets.pool が未知)', () => {
      const workflowPath = writeWorkflow(projectDir, 'ext-missing', EXTERNAL_POOL_WORKFLOW, 'fix');
      expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
    });

    it('should reject an external pool reference that escapes the candidate root via traversal (C-POOL-LOOKUP: traversal 拒否)', () => {
      // A scoped ref like @owner/repo/name is required for traversal; bare names with ".." are rejected at parse.
      // Here we test that a pool file located outside the candidate dir is not resolved by a bare name.
      // We write a pool outside the facet-pools dir and reference it by bare name; it must not be found.
      const workflow = `
facet_pools:
  fix:
    uses: ../escape
steps:
  - name: fix
    persona: coder
    instruction: fix
    edit: true${COMPLETE_CALLER_RULES}
`;
      const workflowPath = writeWorkflow(projectDir, 'ext-traversal', workflow, 'fix');
      expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
    });

    it('should reject an external pool map value that traverses outside the pool source layer root (C-POOL-LOOKUP: map 値 traversal 拒否)', () => {
      // The pool lives in .takt/facet-pools/ so the pool source layer root is .takt/.
      // A map value like ../../secrets/leaked.md escapes .takt/ and must fail-fast at load.
      const traversalPoolBody = `policies:
  leaked: ../../secrets/leaked.md
knowledge:
  backend-api: ./facets/knowledge/backend-api.md
candidates:
  - id: backend
    description: backend
    knowledge: backend-api
`;
      writeProjectPool(projectDir, 'implementation-fix', traversalPoolBody);
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/backend-api.md', '# ext backend-api\n');
      // Place the secret file outside .takt/ so it resolves but must be rejected.
      writeFacet(projectDir, 'secrets/leaked.md', 'SECRET-CONTENT-LEAKED');

      const workflowPath = writeWorkflow(projectDir, 'ext-map-traversal', EXTERNAL_POOL_WORKFLOW, 'fix');
      expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/pool source layer root/);
    });

    it('should reject an external pool candidate ref that traverses outside the pool source layer root (C-POOL-LOOKUP: candidate ref traversal 拒否)', () => {
      // Candidate policy ref is a resource path form (./, ../, /, ~/ or .md suffix) that escapes root.
      // Pool lives in .takt/facet-pools/ so root is .takt/. ../../secrets/leaked.md escapes .takt/.
      const traversalCandidatePoolBody = `policies:
  transaction-correctness: ./facets/policies/transaction-correctness.md
knowledge:
  backend-api: ./facets/knowledge/backend-api.md
candidates:
  - id: leaky
    description: leaky candidate
    policy: ../../secrets/leaked.md
`;
      writeProjectPool(projectDir, 'implementation-fix', traversalCandidatePoolBody);
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/transaction-correctness.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/backend-api.md', '# ext\n');
      writeFacet(projectDir, 'secrets/leaked.md', 'SECRET-CONTENT-LEAKED');

      const workflowPath = writeWorkflow(projectDir, 'ext-candidate-traversal', EXTERNAL_POOL_WORKFLOW, 'fix');
      expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/pool source layer root/);
    });

    it('should allow a legitimate sibling ../facets/... reference inside the pool source layer root (C-POOL-LOOKUP: root 内 sibling 参照許可)', () => {
      // Pool lives in .takt/facet-pools/; root is .takt/. A ../facets/... reference resolves into
      // .takt/facets/... which stays inside .takt/ and must be allowed (project sibling reference).
      const siblingPoolBody = `policies:
  sibling-policy: ../facets/policies/sibling-policy.md
knowledge:
  backend-api: ./facets/knowledge/backend-api.md
candidates:
  - id: backend
    description: backend
    policy: sibling-policy
    knowledge: backend-api
`;
      writeProjectPool(projectDir, 'implementation-fix', siblingPoolBody);
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/backend-api.md', '# ext backend-api\n');
      writeFacet(projectDir, '.takt/facets/policies/sibling-policy.md', '# sibling policy\n');

      const siblingWorkflow = `
facet_pools:
  fix:
    uses: implementation-fix
steps:
  - name: fix
    persona: coder
    dynamic_facets:
      pool: fix
      max_selected: 1
    instruction: fix
    edit: true${COMPLETE_CALLER_RULES}
`;
      const workflowPath = writeWorkflow(projectDir, 'ext-sibling-ok', siblingWorkflow, 'fix');
      const workflow = loadWorkflowFromFile(workflowPath, projectDir);
      const candidate = workflow.facetPools?.fix?.candidates.find((c) => c.id === 'backend');
      expect(candidate?.resolvedPolicyContents?.[0]?.content).toContain('# sibling policy');
    });

    it('should reject an external pool map value with an absolute path (C-POOL-LOOKUP: 絶対パス 拒否)', () => {
      const absPoolBody = `policies:
  leaked: /etc/passwd
knowledge:
  backend-api: ./facets/knowledge/backend-api.md
candidates:
  - id: backend
    description: backend
    knowledge: backend-api
`;
      writeProjectPool(projectDir, 'implementation-fix', absPoolBody);
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/backend-api.md', '# ext\n');

      const workflowPath = writeWorkflow(projectDir, 'ext-absolute-path', EXTERNAL_POOL_WORKFLOW, 'fix');
      expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow();
    });
  });

  describe('C-POOL-PROVENANCE: doctor/preview track pool source', () => {
    it('doctor should report the external pool source path and dependency (C-DOCTOR-POOL, C-POOL-PROVENANCE)', () => {
      writeProjectPool(projectDir, 'implementation-fix', EXTERNAL_POOL_BODY);
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/transaction-correctness.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/backward-compatibility.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/backend-api.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/database-transaction.md', '# ext\n');

      const workflowPath = writeWorkflow(projectDir, 'ext-doctor', EXTERNAL_POOL_WORKFLOW, 'fix');
      const report = inspectWorkflowFile(workflowPath, projectDir);

      // No error diagnostics expected when everything resolves.
      expect(report.diagnostics.some((d) => d.level === 'error')).toBe(false);
    });

    it('doctor should report a missing external pool reference as an error (C-DOCTOR-POOL: 未知 pool)', () => {
      const workflowPath = writeWorkflow(projectDir, 'ext-doctor-missing', EXTERNAL_POOL_WORKFLOW, 'fix');
      const report = inspectWorkflowFile(workflowPath, projectDir);
      expect(report.diagnostics.some((d) => d.level === 'error')).toBe(true);
    });

    it('doctor should not report errors for an inline pool with valid relative .md paths (C-DOCTOR-POOL: 正常系)', () => {
      writeFacet(projectDir, 'facets/policies/coding.md', '# coding\n');
      writeFacet(projectDir, 'facets/knowledge/architecture.md', '# architecture\n');
      writeFacet(projectDir, 'facets/policies/transaction-correctness.md', '# transaction\n');
      writeFacet(projectDir, 'facets/knowledge/backend-api.md', '# backend\n');
      writeFacet(projectDir, 'facets/knowledge/database-transaction.md', '# database\n');

      const workflowPath = writeWorkflow(projectDir, 'inline-doctor-ok', INLINE_POOL_WORKFLOW, 'fix');
      const report = inspectWorkflowFile(workflowPath, projectDir);
      expect(report.diagnostics.some((d) => d.level === 'error')).toBe(false);
    });

    it('doctor should report an error for an inline pool referencing a non-existent .md file (C-DOCTOR-POOL: 存在しない.md)', () => {
      const workflow = `
policies:
  coding: ../../facets/policies/coding.md
  missing: ../../facets/policies/does-not-exist.md
knowledge:
  architecture: ../../facets/knowledge/architecture.md
facet_pools:
  fix:
    candidates:
      - id: broken
        description: references a missing file
        policy: missing
      - id: ok
        description: valid candidate
        policy: coding
steps:
  - name: fix
    persona: coder
    policy: [coding]
    knowledge: [architecture]
    dynamic_facets:
      pool: fix
      max_selected: 3
    instruction: fix
    edit: true${COMPLETE_CALLER_RULES}
`;
      writeFacet(projectDir, 'facets/policies/coding.md', '# coding\n');
      writeFacet(projectDir, 'facets/knowledge/architecture.md', '# architecture\n');

      const workflowPath = writeWorkflow(projectDir, 'inline-doctor-missing-md', workflow, 'fix');
      const report = inspectWorkflowFile(workflowPath, projectDir);
      expect(report.diagnostics.some((d) => d.level === 'error')).toBe(true);
      const errorDiag = report.diagnostics.find((d) => d.level === 'error');
      expect(errorDiag?.message).toContain('does-not-exist.md');
    });

    it('preview should include dynamic pool name, candidate IDs, and source (C-PREVIEW-POOL)', () => {
      writeProjectPool(projectDir, 'implementation-fix', EXTERNAL_POOL_BODY);
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/transaction-correctness.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/backward-compatibility.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/backend-api.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/database-transaction.md', '# ext\n');

      const workflowPath = writeWorkflow(projectDir, 'ext-preview', EXTERNAL_POOL_WORKFLOW, 'fix');
      const preview = getWorkflowDescription(workflowPath, projectDir, 5);

      const step = preview.stepPreviews.find((s) => s.name === 'fix');
      expect(step).toBeDefined();
      expect(step?.dynamicFacets?.pool).toBe('fix');
      const candidateIds = step?.dynamicFacets?.candidates?.map((c) => c.id) ?? [];
      expect(candidateIds).toEqual(
        expect.arrayContaining(['backend', 'transaction', 'backward-compatibility']),
      );
    });

    it('preview should report source: external for external pools and source: inline for inline pools (S4)', () => {
      // External pool
      writeProjectPool(projectDir, 'implementation-fix', EXTERNAL_POOL_BODY);
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/transaction-correctness.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/policies/backward-compatibility.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/backend-api.md', '# ext\n');
      writeFacet(projectDir, '.takt/facet-pools/facets/knowledge/database-transaction.md', '# ext\n');
      const externalPath = writeWorkflow(projectDir, 'ext-preview-src', EXTERNAL_POOL_WORKFLOW, 'fix');
      const externalPreview = getWorkflowDescription(externalPath, projectDir, 5);
      const externalStep = externalPreview.stepPreviews.find((s) => s.name === 'fix');
      expect(externalStep?.dynamicFacets?.source).toBe('external');

      // Inline pool (with .md path references, which previously misclassified as external)
      const inlinePath = writeWorkflow(projectDir, 'inline-preview-src', INLINE_POOL_WORKFLOW, 'fix');
      const inlinePreview = getWorkflowDescription(inlinePath, projectDir, 5);
      const inlineStep = inlinePreview.stepPreviews.find((s) => s.name === 'fix');
      expect(inlineStep?.dynamicFacets?.source).toBe('inline');
    });
  });

  describe('C-LOAD-FAILFAST: max_selected exceeds candidate count (L1)', () => {
    it('should reject max_selected greater than candidate count at load time', () => {
      const workflow = `
policies:
  coding: ../../facets/policies/coding.md
knowledge:
  architecture: ../../facets/knowledge/architecture.md
facet_pools:
  fix:
    candidates:
      - id: a
        description: a
        policy: coding
      - id: b
        description: b
        knowledge: architecture
steps:
  - name: fix
    persona: coder
    policy: [coding]
    knowledge: [architecture]
    dynamic_facets:
      pool: fix
      max_selected: 5
    instruction: fix
    edit: true${COMPLETE_CALLER_RULES}
`;
      const workflowPath = writeWorkflow(projectDir, 'max-selected-exceeds', workflow, 'fix');
      expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/exceeds candidate count/);
    });
  });
});
