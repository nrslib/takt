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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveRefToContent,
  type FacetResolutionContext,
} from '../infra/config/loaders/resource-resolver.js';

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

    const base = 'Do the task.';
    const partial = 'Shared rules content';
    const extra = 'Extra constraints.';
    writeFileSync(join(partialsDir, 'common-rules.md'), partial);
    writeFileSync(join(instructionsDir, 'implement-maintenance.md'),
      `${base}\n\n{{include:instructions/common-rules}}\n\n${extra}`);

    const content = resolveRefToContent('implement-maintenance', undefined, tempDir, 'instructions', context);
    expect(content).toContain(base);
    expect(content).toContain(partial);
    expect(content).toContain(extra);
    expect(content).not.toContain('{{include:instructions/common-rules}}');
  });

  it('should expand {{include:policies/<name>}} in a policy facet', () => {
    const policiesDir = join(tempDir, '.takt', 'facets', 'policies');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'policies');
    mkdirSync(policiesDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });

    const base = 'Testing policy.';
    const partial = 'No layer duplication.';
    writeFileSync(join(partialsDir, 'layer-dedup.md'), partial);
    writeFileSync(join(policiesDir, 'testing-mild.md'),
      `${base}\n\n{{include:policies/layer-dedup}}`);

    const content = resolveRefToContent('testing-mild', undefined, tempDir, 'policies', context);
    expect(content).toContain(base);
    expect(content).toContain(partial);
    expect(content).not.toContain('{{include:policies/layer-dedup}}');
  });

  it('should expand {{include:knowledge/<name>}} in a knowledge facet', () => {
    const knowledgeDir = join(tempDir, '.takt', 'facets', 'knowledge');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });

    const base = 'Backend knowledge.';
    const partial = 'Architecture overview.';
    writeFileSync(join(partialsDir, 'common-arch.md'), partial);
    writeFileSync(join(knowledgeDir, 'backend-extended.md'),
      `${base}\n\n{{include:knowledge/common-arch}}`);

    const content = resolveRefToContent('backend-extended', undefined, tempDir, 'knowledge', context);
    expect(content).toContain(base);
    expect(content).toContain(partial);
    expect(content).not.toContain('{{include:knowledge/common-arch}}');
  });

  it('should expand includes after inheritance (extends then include)', () => {
    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });

    const base = 'Base instruction with';
    const partial = 'CHECK PASSED';
    const child = 'Child additions.';
    writeFileSync(join(instructionsDir, 'base.md'), `${base} {{include:instructions/shared-check}}.`);
    writeFileSync(join(partialsDir, 'shared-check.md'), partial);
    writeFileSync(join(instructionsDir, 'child.md'),
      `{extends:base}\n\n${child}`);

    const content = resolveRefToContent('child', undefined, tempDir, 'instructions', context);
    expect(content).toContain(base);
    expect(content).toContain(partial);
    expect(content).toContain(child);
    expect(content).not.toContain('{{include:instructions/shared-check}}');
  });

  it('should throw on missing include', () => {
    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });

    writeFileSync(join(instructionsDir, 'broken.md'),
      'Before.\n\n{{include:instructions/nonexistent}}\n\nAfter.');

    expect(() => resolveRefToContent('broken', undefined, tempDir, 'instructions', context))
      .toThrow();
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
      .toThrow();
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

});
