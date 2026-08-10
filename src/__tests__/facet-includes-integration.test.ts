/**
 * Tests for {{include:<kind>/<name>}} expansion in facet resolution.
 *
 * Covers:
 * - include expansion in instruction, policy, knowledge facets
 * - include after inheritance (extends + include)
 * - missing include error
 * - cyclic include error
 * - inline content (no sourcePath) skips include expansion
 * - project partial overrides builtin partial
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import {
  resolveRefToContent,
  type FacetResolutionContext,
} from '../infra/config/loaders/resource-resolver.js';
import { getLanguageResourcesDir } from '../infra/resources/index.js';

describe('facet include expansion', () => {
  let tempDir: string;
  let context: FacetResolutionContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-include-test-'));
    context = { projectDir: tempDir, lang: 'ja' };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should expand {{include:instructions/<name>}} in an instruction facet', () => {
    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });

    writeFileSync(join(partialsDir, 'common-rules.md'), 'Shared rules content');
    writeFileSync(join(instructionsDir, 'implement-maintenance.md'),
      'Do the task.\n\n{{include:instructions/common-rules}}\n\nExtra constraints.');

    const content = resolveRefToContent('implement-maintenance', undefined, tempDir, 'instructions', context);
    expect(content).toBe('Do the task.\n\nShared rules content\n\nExtra constraints.');
  });

  it.each(['en', 'ja'] as const)('should expand the builtin PR review guidance in %s', (lang) => {
    const partial = readFileSync(
      join(getLanguageResourcesDir(lang), 'facets', 'partials', 'instructions', 'review-pr-context.md'),
      'utf-8',
    ).trim();
    const content = resolveRefToContent(
      'review-coding',
      undefined,
      tempDir,
      'instructions',
      { projectDir: tempDir, lang },
    );

    expect(content).toContain(partial);
    expect(content).not.toContain('{{include:instructions/review-pr-context}}');
  });

  it.each(['en', 'ja'] as const)('should compose the builtin fix-family contract into fix instructions in %s', (lang) => {
    const partial = readFileSync(
      join(getLanguageResourcesDir(lang), 'facets', 'partials', 'instructions', 'fix-family-completion.md'),
      'utf-8',
    ).trim();

    for (const instruction of [
      'fix',
      'fix-finding-contract',
      'ai-antipattern-fix',
      'fix-maintenance',
      'fix-supervisor',
      'apply-fix-plan',
    ]) {
      const content = resolveRefToContent(
        instruction,
        undefined,
        tempDir,
        'instructions',
        { projectDir: tempDir, lang },
      );

      expect(content).toContain(partial);
      expect(content).not.toContain('{{include:instructions/fix-family-completion}}');
    }
  });

  it.each(['en', 'ja'] as const)('should compose root-cause analysis into planning and direct fix instructions in %s', (lang) => {
    const partial = readFileSync(
      join(getLanguageResourcesDir(lang), 'facets', 'partials', 'instructions', 'fix-root-cause-analysis.md'),
      'utf-8',
    ).trim();

    for (const instruction of [
      'fix-plan',
      'fix-plan-finding-contract',
      'fix',
      'fix-finding-contract',
      'ai-antipattern-fix',
      'fix-maintenance',
      'fix-supervisor',
    ]) {
      const content = resolveRefToContent(
        instruction,
        undefined,
        tempDir,
        'instructions',
        { projectDir: tempDir, lang },
      );

      expect(content).toContain(partial);
      expect(content).not.toContain('{{include:instructions/fix-root-cause-analysis}}');
    }
  });

  it.each(['en', 'ja'] as const)('should compose one fix-plan validity contract across planning, fixing, and verification in %s', (lang) => {
    const partial = readFileSync(
      join(getLanguageResourcesDir(lang), 'facets', 'partials', 'instructions', 'fix-plan-validity.md'),
      'utf-8',
    ).trim();

    for (const instruction of [
      'fix-plan',
      'fix-plan-finding-contract',
      'apply-fix-plan',
      'verify-fix',
    ]) {
      const content = resolveRefToContent(
        instruction,
        undefined,
        tempDir,
        'instructions',
        { projectDir: tempDir, lang },
      );

      expect(content).toContain(partial);
      expect(content).not.toContain('{{include:instructions/fix-plan-validity}}');
    }
  });

  it('should expand {{include:policies/<name>}} in a policy facet', () => {
    const policiesDir = join(tempDir, '.takt', 'facets', 'policies');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'policies');
    mkdirSync(policiesDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });

    writeFileSync(join(partialsDir, 'layer-dedup.md'), 'No layer duplication.');
    writeFileSync(join(policiesDir, 'testing-mild.md'),
      'Testing policy.\n\n{{include:policies/layer-dedup}}');

    const content = resolveRefToContent('testing-mild', undefined, tempDir, 'policies', context);
    expect(content).toBe('Testing policy.\n\nNo layer duplication.');
  });

  it('should expand {{include:knowledge/<name>}} in a knowledge facet', () => {
    const knowledgeDir = join(tempDir, '.takt', 'facets', 'knowledge');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });

    writeFileSync(join(partialsDir, 'common-arch.md'), 'Architecture overview.');
    writeFileSync(join(knowledgeDir, 'backend-extended.md'),
      'Backend knowledge.\n\n{{include:knowledge/common-arch}}');

    const content = resolveRefToContent('backend-extended', undefined, tempDir, 'knowledge', context);
    expect(content).toBe('Backend knowledge.\n\nArchitecture overview.');
  });

  it('should expand includes after inheritance (extends then include)', () => {
    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });

    writeFileSync(join(instructionsDir, 'base.md'), 'Base instruction with {{include:instructions/shared-check}}.');
    writeFileSync(join(partialsDir, 'shared-check.md'), 'CHECK PASSED');
    writeFileSync(join(instructionsDir, 'child.md'),
      '{extends:base}\n\nChild additions.');

    const content = resolveRefToContent('child', undefined, tempDir, 'instructions', context);
    expect(content).toBe('Base instruction with CHECK PASSED.\n\nChild additions.');
  });

  it('should throw on missing include', () => {
    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });

    writeFileSync(join(instructionsDir, 'broken.md'),
      'Before.\n\n{{include:instructions/nonexistent}}\n\nAfter.');

    expect(() => resolveRefToContent('broken', undefined, tempDir, 'instructions', context))
      .toThrow(/Missing facet include/);
  });

  it('should throw on cyclic includes', () => {
    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });

    writeFileSync(join(instructionsDir, 'cyclic.md'), '{{include:instructions/first}}');
    writeFileSync(join(partialsDir, 'first.md'), '{{include:instructions/second}}');
    writeFileSync(join(partialsDir, 'second.md'), '{{include:instructions/first}}');

    expect(() => resolveRefToContent('cyclic', undefined, tempDir, 'instructions', context))
      .toThrow(/Cyclic facet include/);
  });

  it('should NOT expand includes in inline content (no sourcePath)', () => {
    const resolvedMap = { 'my-policy': 'Inline with {{include:policies/something}}' };
    const content = resolveRefToContent('my-policy', resolvedMap, tempDir, 'policies', context);
    expect(content).toBe('Inline with {{include:policies/something}}');
  });

  it('should prefer project partial over builtin partial with the same name', () => {
    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    const projectPartialsDir = join(tempDir, '.takt', 'facets', 'partials', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });
    mkdirSync(projectPartialsDir, { recursive: true });

    writeFileSync(join(projectPartialsDir, 'implement-common.md'), 'Project version');
    writeFileSync(join(instructionsDir, 'test.md'),
      '{{include:instructions/implement-common}}');

    const content = resolveRefToContent('test', undefined, tempDir, 'instructions', context);
    expect(content).toBe('Project version');
  });

  it('should resolve includes from the source facet layer in package workflows', () => {
    const repertoireDir = join(tempDir, 'repertoire');
    const workflowDir = join(repertoireDir, '@nrslib', 'pkg', 'workflows');
    context = { projectDir: tempDir, lang: 'ja', workflowDir, repertoireDir };

    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    const projectPartialsDir = join(tempDir, '.takt', 'facets', 'partials', 'instructions');
    const packagePartialsDir = join(repertoireDir, '@nrslib', 'pkg', 'facets', 'partials', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });
    mkdirSync(projectPartialsDir, { recursive: true });
    mkdirSync(packagePartialsDir, { recursive: true });

    writeFileSync(join(packagePartialsDir, 'shared.md'), 'Package version');
    writeFileSync(join(projectPartialsDir, 'shared.md'), 'Project version');
    writeFileSync(join(instructionsDir, 'test.md'), '{{include:instructions/shared}}');

    const content = resolveRefToContent('test', undefined, workflowDir, 'instructions', context);
    expect(content).toBe('Project version');
  });

  it.each(['en', 'ja'] as const)('should share the common review policy and add the security boundary once in %s', (lang) => {
    const languageRoot = getLanguageResourcesDir(lang);
    const common = readFileSync(
      join(languageRoot, 'facets', 'partials', 'policies', 'review-common.md'),
      'utf-8',
    ).trim();
    const review = resolveRefToContent(
      'review',
      undefined,
      tempDir,
      'policies',
      { projectDir: tempDir, lang },
    );
    const securityReview = resolveRefToContent(
      'security-review',
      undefined,
      tempDir,
      'policies',
      { projectDir: tempDir, lang },
    );

    const resolvedReview = review?.trim();
    const resolvedSecurityReview = securityReview?.trim();
    expect(resolvedReview).toBe(common);
    expect(resolvedSecurityReview).toContain(common);
    expect(resolvedSecurityReview?.split(common)).toHaveLength(2);
    expect(resolvedSecurityReview).toContain('blocking finding');

    const warningOnlyApproval = lang === 'ja'
      ? 'Warning または対象外の事項だけが残る場合は APPROVE'
      : 'When only warnings or out-of-scope items remain, return APPROVE';
    expect(resolvedSecurityReview).toContain(warningOnlyApproval);
  });

  it.each(['en', 'ja'] as const)('should route every builtin review-security entry through the security policy in %s', (lang) => {
    const roots = ['steps', 'workflows'].map((directory) => join(getLanguageResourcesDir(lang), directory));
    const yamlFiles = roots.flatMap((root) => listYamlFiles(root));
    const routes = yamlFiles.flatMap((filePath) => {
      const parsed = parseYaml(readFileSync(filePath, 'utf-8')) as unknown;
      return collectRecords(parsed).filter((record) => record.instruction === 'review-security')
        .map((record) => ({ filePath, record }));
    });

    expect(routes.length).toBeGreaterThan(0);
    for (const { filePath, record } of routes) {
      expect(record.persona, filePath).toBe('security-reviewer');
      const policies = collectStrings(record.policy);
      expect(policies, filePath).toContain('security-review');
      expect(policies, filePath).not.toContain('review');
      const additionsIndex = policies.indexOf('$param: review_policy_additions');
      if (additionsIndex >= 0) {
        expect(policies.indexOf('security-review'), filePath).toBeGreaterThan(additionsIndex);
      }
    }
  });

  it.each(['en', 'ja'] as const)('should preserve the fixed workflow security knowledge mapping in %s', (lang) => {
    const languageRoot = getLanguageResourcesDir(lang);
    const mappings: Record<string, { persona: string; knowledge: string[] }> = {
      'review-frontend.yaml': {
        persona: 'security-reviewer',
        knowledge: ['security', 'security-web', 'security-data', 'security-dependencies'],
      },
      'review-fix-frontend.yaml': {
        persona: 'security-reviewer',
        knowledge: ['security', 'security-web', 'security-data', 'security-dependencies'],
      },
      'review-backend.yaml': {
        persona: 'security-reviewer',
        knowledge: ['security', 'security-api', 'security-data', 'security-dependencies'],
      },
      'review-backend-cqrs.yaml': {
        persona: 'security-reviewer',
        knowledge: ['security', 'security-api', 'security-data', 'security-dependencies'],
      },
      'review-fix-backend.yaml': {
        persona: 'security-reviewer',
        knowledge: ['security', 'security-api', 'security-data', 'security-dependencies'],
      },
      'review-fix-backend-cqrs.yaml': {
        persona: 'security-reviewer',
        knowledge: ['security', 'security-api', 'security-data', 'security-dependencies'],
      },
      'review-dual.yaml': {
        persona: 'security-reviewer',
        knowledge: ['security', 'security-web', 'security-api', 'security-data', 'security-dependencies'],
      },
      'review-dual-cqrs.yaml': {
        persona: 'security-reviewer',
        knowledge: ['security', 'security-web', 'security-api', 'security-data', 'security-dependencies'],
      },
      'review-fix-dual.yaml': {
        persona: 'security-reviewer',
        knowledge: ['security', 'security-web', 'security-api', 'security-data', 'security-dependencies'],
      },
      'review-fix-dual-cqrs.yaml': {
        persona: 'security-reviewer',
        knowledge: ['security', 'security-web', 'security-api', 'security-data', 'security-dependencies'],
      },
      'review-default.yaml': {
        persona: 'security-reviewer',
        knowledge: ['security', 'security-web', 'security-api', 'security-local', 'security-data', 'security-dependencies'],
      },
      'review-fix-default.yaml': {
        persona: 'security-reviewer',
        knowledge: ['security', 'security-web', 'security-api', 'security-local', 'security-data', 'security-dependencies'],
      },
      'review-takt-default.yaml': {
        persona: 'security-reviewer',
        knowledge: ['takt', 'security', 'security-local', 'security-data', 'security-dependencies'],
      },
    };

    for (const [fileName, expected] of Object.entries(mappings)) {
      const parsed = parseYaml(readFileSync(join(languageRoot, 'workflows', fileName), 'utf-8')) as unknown;
      const route = collectRecords(parsed).find((record) => record.instruction === 'review-security');
      expect(route, fileName).toBeDefined();
      expect(route?.persona, fileName).toBe(expected.persona);
      expect(collectStrings(route?.knowledge), fileName).toEqual(expected.knowledge);
    }

    const audit = parseYaml(readFileSync(join(languageRoot, 'workflows', 'audit-security.yaml'), 'utf-8')) as unknown;
    for (const route of collectRecords(audit).filter((record) => (
      record.persona === 'security-reviewer' && typeof record.instruction === 'string'
      && record.instruction.startsWith('audit-security')
    ))) {
      expect(collectStrings(route.knowledge)).toEqual([
        'security',
        'security-web',
        'security-api',
        'security-local',
        'security-data',
        'security-dependencies',
      ]);
    }
  });

  it.each(['en', 'ja'] as const)('should configure one security reviewer for each peer-review suite in %s', (lang) => {
    const languageRoot = getLanguageResourcesDir(lang);
    const mappings: Record<string, string[]> = {
      'peer-review-suite-frontend.yaml': ['security', 'security-web', 'security-data', 'security-dependencies'],
      'peer-review-suite-backend.yaml': ['security', 'security-api', 'security-data', 'security-dependencies'],
      'peer-review-suite-cqrs.yaml': ['security', 'security-api', 'security-data', 'security-dependencies'],
      'peer-review-suite-dual.yaml': ['security', 'security-web', 'security-api', 'security-data', 'security-dependencies'],
      'peer-review-suite-frontend-cqrs.yaml': ['security', 'security-web', 'security-api', 'security-data', 'security-dependencies'],
      'peer-review-suite-finding-contract-takt.yaml': ['takt', 'security', 'security-local', 'security-data', 'security-dependencies'],
    };

    for (const [fileName, expectedKnowledge] of Object.entries(mappings)) {
      const parsed = parseYaml(readFileSync(join(languageRoot, 'workflows', fileName), 'utf-8')) as unknown;
      const args = collectRecords(parsed).find((record) => Array.isArray(record.security_review_knowledge));
      expect(args, fileName).toBeDefined();
      expect(collectStrings(args?.security_review_knowledge), fileName).toEqual(expectedKnowledge);
    }

    const workflowSuites: Record<string, string> = {
      'backend.yaml': 'peer-review-suite-backend',
      'backend-maintenance.yaml': 'peer-review-suite-backend',
      'frontend.yaml': 'peer-review-suite-frontend',
      'frontend-maintenance.yaml': 'peer-review-suite-frontend',
      'dual.yaml': 'peer-review-suite-dual',
      'backend-cqrs.yaml': 'peer-review-suite-cqrs',
      'dual-cqrs.yaml': 'peer-review-suite-frontend-cqrs',
      'takt-default-fc.yaml': 'peer-review-suite-finding-contract-takt',
    };
    for (const [fileName, suite] of Object.entries(workflowSuites)) {
      const parsed = parseYaml(readFileSync(join(languageRoot, 'workflows', fileName), 'utf-8')) as unknown;
      expect(collectRecords(parsed).some((record) => record.reviewer_suite === suite), fileName).toBe(true);
    }
  });

  it.each(['en', 'ja'] as const)('should keep the experimental security candidates as single generic or TAKT entries in %s', (lang) => {
    const languageRoot = getLanguageResourcesDir(lang);
    const experimental = parseYaml(readFileSync(join(languageRoot, 'steps', 'experimental-review.yaml'), 'utf-8')) as Record<string, unknown>;
    const securityCandidates = ((experimental.parallel as Record<string, unknown>).pool as Array<Record<string, unknown>>)
      .filter((candidate) => candidate.persona === 'security-reviewer');
    expect(securityCandidates).toHaveLength(1);
    expect(securityCandidates[0]?.name).toBe('security-review');
    expect(collectStrings(securityCandidates[0]?.knowledge)).toEqual([
      'security',
      'security-web',
      'security-api',
      'security-local',
      'security-data',
      'security-dependencies',
    ]);
    expect(collectStrings(securityCandidates[0]?.output_contracts)).toContain('security-review.md');

    const takt = parseYaml(readFileSync(join(languageRoot, 'workflows', 'takt-experimental-review.yaml'), 'utf-8')) as Record<string, unknown>;
    const taktStep = (takt.steps as Array<Record<string, unknown>>)[0];
    const taktPool = ((taktStep.parallel as Record<string, unknown>).pool as Array<Record<string, unknown>>)
      .filter((candidate) => candidate.persona === 'security-reviewer');
    expect(taktPool).toHaveLength(1);
    expect(taktPool[0]?.name).toBe('security-review');
    expect(collectStrings(taktPool[0]?.knowledge)).toEqual([
      'takt',
      'security',
      'security-local',
      'security-data',
      'security-dependencies',
    ]);
    expect(collectStrings(taktPool[0]?.output_contracts)).toContain('security-review.md');
    const taktRules = ((taktStep.rules as Record<string, unknown>).parallel as Record<string, unknown>);
    expect(taktRules['security-review']).toBeDefined();
  });

  it.each(['en', 'ja'] as const)('should keep security domains separate and apply explicit routing in %s', (lang) => {
    const domains = [
      'security-web',
      'security-api',
      'security-local',
      'security-data',
      'security-dependencies',
    ];
    const context = { projectDir: tempDir, lang };
    const common = resolveRefToContent('security', undefined, tempDir, 'knowledge', context);
    const instruction = resolveRefToContent('review-security', undefined, tempDir, 'instructions', context);

    for (const domain of domains) {
      expect(common).not.toContain(domain);
      const specialized = resolveRefToContent(domain, undefined, tempDir, 'knowledge', context);
      expect(specialized).toContain(lang === 'ja' ? '## 適用条件' : '## Applicability');
    }
    expect(common).not.toContain(lang === 'ja' ? '# Webセキュリティ知識' : '# Web Security Knowledge');
    expect(instruction).toContain(lang === 'ja'
      ? 'stepに付与されたKnowledgeだけを使用する'
      : 'Use only the Knowledge assigned to the step');
    expect(instruction).not.toContain('{{include:instructions/security-knowledge-routing}}');
  });
});

function listYamlFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const filePath = join(root, entry);
    return statSync(filePath).isDirectory()
      ? listYamlFiles(filePath)
      : filePath.endsWith('.yaml') || filePath.endsWith('.yml') ? [filePath] : [];
  });
}

function collectRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(collectRecords);
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(collectRecords)];
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(collectStrings);
}
