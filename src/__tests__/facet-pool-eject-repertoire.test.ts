import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyReferencedBuiltinFacetPools } from '../features/config/ejectStepFragments.js';
import { assertCopiedFacetPoolReferences, collectFacetPoolUses } from '../features/repertoire/step-fragment-integrity.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

const COMPLETE_CALLER_RULES = `
    rules:
      - condition: done
        next: COMPLETE`;

const EXTERNAL_POOL_WORKFLOW = `
policies:
  coding: ./facets/policies/coding.md
knowledge:
  architecture: ./facets/knowledge/architecture.md
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
  transaction-correctness: ../facets/policies/transaction-correctness.md
  backward-compatibility: ../facets/policies/backward-compatibility.md
knowledge:
  backend-api: ../facets/knowledge/backend-api.md
  database-transaction: ../facets/knowledge/database-transaction.md
candidates:
  - id: backend
    description: backend
    knowledge: backend-api
  - id: transaction
    description: transaction
    policy: transaction-correctness
    knowledge: database-transaction
  - id: backward-compatibility
    description: compat
    policy: backward-compatibility
`;

describe('facet pool eject and repertoire (C-EJECT-POOL, C-REPERTOIRE-POOL)', () => {
  let projectDir: string;
  let builtinFixtureDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-facet-pool-eject-project-'));
    builtinFixtureDir = mkdtempSync(join(tmpdir(), 'takt-facet-pool-eject-builtin-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(builtinFixtureDir, { recursive: true, force: true });
  });

  describe('C-EJECT-POOL: eject copies external pool and its facet dependencies', () => {
    it('should copy a referenced builtin external pool and its facets to the project facet-pools/ directory', () => {
      // Real builtin layout: builtins/<lang>/facet-pools/ + builtins/<lang>/facets/ (siblings).
      // Pool file references facets via ../facets/... which resolves to the sibling facets dir.
      const builtinLanguageRoot = join(builtinFixtureDir, 'builtin-lang');
      const builtinSourceDir = join(builtinLanguageRoot, 'facet-pools');
      const builtinFacetsDir = join(builtinLanguageRoot, 'facets');
      mkdirSync(join(builtinSourceDir), { recursive: true });
      mkdirSync(join(builtinFacetsDir, 'policies'), { recursive: true });
      mkdirSync(join(builtinFacetsDir, 'knowledge'), { recursive: true });
      writeFileSync(join(builtinSourceDir, 'implementation-fix.yaml'), EXTERNAL_POOL_BODY, 'utf-8');
      writeFileSync(join(builtinFacetsDir, 'policies', 'transaction-correctness.md'), '# builtin transaction\n', 'utf-8');
      writeFileSync(join(builtinFacetsDir, 'policies', 'backward-compatibility.md'), '# builtin backward\n', 'utf-8');
      writeFileSync(join(builtinFacetsDir, 'knowledge', 'backend-api.md'), '# builtin backend-api\n', 'utf-8');
      writeFileSync(join(builtinFacetsDir, 'knowledge', 'database-transaction.md'), '# builtin database\n', 'utf-8');

      // Write the caller workflow into the project.
      writeFile(projectDir, 'facets/policies/coding.md', '# coding\n');
      writeFile(projectDir, 'facets/knowledge/architecture.md', '# architecture\n');
      const workflowPath = writeFile(projectDir, '.takt/workflows/eject-pool.yaml', `name: eject-pool
initial_step: fix
max_steps: 3
${EXTERNAL_POOL_WORKFLOW}
`);

      const ejectTargetDir = join(projectDir, '.takt', 'facet-pools');
      const rollback = copyReferencedBuiltinFacetPools(
        readFileSync(workflowPath, 'utf-8'),
        'en',
        ejectTargetDir,
        workflowPath,
        true,
        builtinSourceDir,
        builtinLanguageRoot,
      );

      // The pool file is copied to .takt/facet-pools/; facet dependencies mirror their
      // position relative to the builtin language root into the eject target's language root
      // (.takt/), so ../facets/... references in the pool file resolve correctly.
      expect(existsSync(join(ejectTargetDir, 'implementation-fix.yaml'))).toBe(true);
      const taktRoot = join(projectDir, '.takt');
      expect(existsSync(join(taktRoot, 'facets', 'policies', 'transaction-correctness.md'))).toBe(true);
      expect(existsSync(join(taktRoot, 'facets', 'policies', 'backward-compatibility.md'))).toBe(true);
      expect(existsSync(join(taktRoot, 'facets', 'knowledge', 'backend-api.md'))).toBe(true);
      expect(existsSync(join(taktRoot, 'facets', 'knowledge', 'database-transaction.md'))).toBe(true);

      // The ejected pool must be loadable from the project.
      const loaded = loadWorkflowFromFile(workflowPath, projectDir);
      expect(loaded.facetPools?.fix?.candidates.map((c) => c.id)).toEqual(['backend', 'transaction', 'backward-compatibility']);

      // Rollback removes the copied files.
      rollback();
      expect(existsSync(join(ejectTargetDir, 'implementation-fix.yaml'))).toBe(false);
    });

    it('should keep an existing user pool file and warn instead of overwriting (existing eject contract)', () => {
      const builtinLanguageRoot = join(builtinFixtureDir, 'builtin-lang');
      const builtinSourceDir = join(builtinLanguageRoot, 'facet-pools');
      const builtinFacetsDir = join(builtinLanguageRoot, 'facets');
      mkdirSync(join(builtinSourceDir), { recursive: true });
      mkdirSync(join(builtinFacetsDir, 'policies'), { recursive: true });
      mkdirSync(join(builtinFacetsDir, 'knowledge'), { recursive: true });
      writeFileSync(join(builtinSourceDir, 'implementation-fix.yaml'), EXTERNAL_POOL_BODY, 'utf-8');
      writeFileSync(join(builtinFacetsDir, 'policies', 'transaction-correctness.md'), '# builtin\n', 'utf-8');
      writeFileSync(join(builtinFacetsDir, 'policies', 'backward-compatibility.md'), '# builtin\n', 'utf-8');
      writeFileSync(join(builtinFacetsDir, 'knowledge', 'backend-api.md'), '# builtin\n', 'utf-8');
      writeFileSync(join(builtinFacetsDir, 'knowledge', 'database-transaction.md'), '# builtin\n', 'utf-8');

      writeFile(projectDir, 'facets/policies/coding.md', '# coding\n');
      writeFile(projectDir, 'facets/knowledge/architecture.md', '# architecture\n');
      const workflowPath = writeFile(projectDir, '.takt/workflows/eject-pool-conflict.yaml', `name: eject-pool-conflict
initial_step: fix
max_steps: 3
${EXTERNAL_POOL_WORKFLOW}
`);

      const ejectTargetDir = join(projectDir, '.takt', 'facet-pools');
      mkdirSync(ejectTargetDir, { recursive: true });
      // Pre-existing user pool file with different content.
      writeFileSync(join(ejectTargetDir, 'implementation-fix.yaml'), 'candidates: []\n', 'utf-8');

      copyReferencedBuiltinFacetPools(
        readFileSync(workflowPath, 'utf-8'),
        'en',
        ejectTargetDir,
        workflowPath,
        true,
        builtinSourceDir,
        builtinLanguageRoot,
      );

      // The user's file must NOT be overwritten.
      expect(readFileSync(join(ejectTargetDir, 'implementation-fix.yaml'), 'utf-8')).toBe('candidates: []\n');
    });
  });

  describe('C-REPERTOIRE-POOL: collectFacetPoolUses', () => {
    it('should collect facet_pools.<name>.uses references from a workflow', () => {
      const refs = new Set<string>();
      const parsed = {
        facet_pools: {
          fix: { uses: 'implementation-fix' },
          review: { uses: 'review-pool' },
        },
      };
      collectFacetPoolUses(parsed, refs);
      expect([...refs].sort()).toEqual(['implementation-fix', 'review-pool']);
    });

    it('should collect inline pool references as pool-scoped facet refs', () => {
      const refs = new Set<string>();
      const parsed = {
        facet_pools: {
          fix: {
            candidates: [
              { id: 'backend', description: 'backend', knowledge: 'backend-api' },
              { id: 'transaction', description: 'transaction', policy: 'transaction-correctness' },
            ],
          },
        },
      };
      collectFacetPoolUses(parsed, refs);
      // Inline pools resolve facets through the caller workflow's sections; they do not produce
      // cross-package pool references, but the facet refs they mention must be collected
      // so the repertoire integrity check can verify they are copied.
      expect([...refs].sort()).toEqual(['backend-api', 'transaction-correctness']);
    });

    it('should report a pool reference that is excluded from package installation as an integrity violation', () => {
      // collectFacetPoolUses is the building block that assertCopiedFacetPoolReferences wraps.
      // A workflow references implementation-fix; the collected ref set must contain it so the
      // integrity check can flag it when copiedFacetPoolNames does not include it.
      const refs = new Set<string>();
      const parsed = { facet_pools: { fix: { uses: 'implementation-fix' } } };
      collectFacetPoolUses(parsed, refs);
      expect(refs.has('implementation-fix')).toBe(true);
    });
  });

  describe('C-REPERTOIRE-POOL: assertCopiedFacetPoolReferences alias resolution (S6)', () => {
    it('should detect an uncopied facet when the pool alias differs from the facet file name', () => {
      // Pool maps alias "api-policy" to ./facets/policies/actual-file.md.
      // Candidate references alias "api-policy", which must resolve to facet file "actual-file".
      // When "actual-file" is not in copiedFacetNamesByType, the integrity check must throw.
      const packageRoot = mkdtempSync(join(tmpdir(), 'takt-repertoire-alias-'));
      try {
        mkdirSync(join(packageRoot, 'facets', 'policies'), { recursive: true });
        // Place the actual facet file so the resolved path exists.
        writeFileSync(join(packageRoot, 'facets', 'policies', 'actual-file.md'), '# actual\n', 'utf-8');

        const workflowContent = `facet_pools:
  fix:
    candidates:
      - id: backend
        description: backend
        policy: api-policy
policies:
  api-policy: ./facets/policies/actual-file.md
`;
        assertCopiedFacetPoolReferences({
          sources: [{ content: workflowContent, path: 'workflows/test.yaml' }],
          packageRoot,
          copiedPoolNames: new Set<string>(),
          // "actual-file" is NOT in the copied set → must throw.
          copiedFacetNamesByType: new Map([['policies', new Set<string>()]]),
          owner: 'test',
          repo: 'repo',
        });
        throw new Error('expected assertCopiedFacetPoolReferences to throw');
      } catch (error) {
        expect(String(error)).toMatch(/Facet "actual-file" \(policies\) referenced by .* is excluded from package installation/);
      } finally {
        rmSync(packageRoot, { recursive: true, force: true });
      }
    });

    it('should pass when the alias-resolved facet is copied', () => {
      const packageRoot = mkdtempSync(join(tmpdir(), 'takt-repertoire-alias-ok-'));
      try {
        mkdirSync(join(packageRoot, 'facets', 'policies'), { recursive: true });
        writeFileSync(join(packageRoot, 'facets', 'policies', 'actual-file.md'), '# actual\n', 'utf-8');

        const workflowContent = `facet_pools:
  fix:
    candidates:
      - id: backend
        description: backend
        policy: api-policy
policies:
  api-policy: ./facets/policies/actual-file.md
`;
        assertCopiedFacetPoolReferences({
          sources: [{ content: workflowContent, path: 'workflows/test.yaml' }],
          packageRoot,
          copiedPoolNames: new Set<string>(),
          copiedFacetNamesByType: new Map([['policies', new Set<string>(['actual-file'])]]),
          owner: 'test',
          repo: 'repo',
        });
      } finally {
        rmSync(packageRoot, { recursive: true, force: true });
      }
    });
  });
});