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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

  it.each(['en', 'ja'] as const)(
    'should keep scenario addons structurally separate from base facets in %s',
    (lang) => {
      const facetContext = { projectDir: tempDir, lang };
      const assertions = [
        ['instructions', 'plan', 'requirement-scenario-planning'],
        ['instructions', 'plan-maintenance', 'requirement-scenario-planning'],
        ['instructions', 'write-tests-first', 'requirement-scenario-test-mapping'],
        ['instructions', 'replan-implementation', 'requirement-scenario-maintenance'],
        ['instructions', 'fix-plan-from-review-resolution', 'requirement-scenario-maintenance'],
        ['instructions', 'review-merge-readiness', 'requirement-scenario-verification'],
        ['instructions', 'supervise-merge-readiness', 'requirement-scenario-verification'],
        ['output-contracts', 'plan', 'requirement-scenarios-plan'],
        ['output-contracts', 'fix-plan', 'requirement-scenarios-fix-plan'],
        ['output-contracts', 'test-report', 'requirement-scenarios-test-report'],
      ] as const;

      for (const [kind, name, scenarioPartial] of assertions) {
        const scenarioName = `scenario-based-${name}`;
        const scenarioAddon = readFileSync(join(
          getLanguageResourcesDir(lang),
          'facets',
          'partials',
          kind,
          `${scenarioPartial}.md`,
        ), 'utf-8').trim();

        const normalContent = resolveRefToContent(
          name,
          undefined,
          tempDir,
          kind,
          facetContext,
        );
        const scenarioContent = resolveRefToContent(
          scenarioName,
          undefined,
          tempDir,
          kind,
          facetContext,
        );

        expect(normalContent, name).toBeDefined();
        expect(scenarioContent, scenarioName).toBeDefined();
        const normalizeFacetSpacing = (value: string): string => value.trim().replace(/\n{3,}/gu, '\n\n');
        expect(normalizeFacetSpacing(scenarioContent!), scenarioName)
          .toBe(normalizeFacetSpacing(`${normalContent!}\n\n${scenarioAddon}`));
      }
    },
  );

  it.each(['en', 'ja'] as const)('should compose the builtin fix role into fix instructions in %s', (lang) => {
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

      expect(content).toContain('**Contract family role: `fix`**');
      expect(content).toContain('**Contract family core**');
      expect(content).not.toContain('{{include:instructions/contract-family-fix}}');
      expect(content).not.toContain('{{include:instructions/contract-family-core}}');
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
    expect(resolvedReview).toBeDefined();
    expect(resolvedSecurityReview).toContain(resolvedReview);
    expect(resolvedSecurityReview?.split(resolvedReview!)).toHaveLength(2);
  });
});
