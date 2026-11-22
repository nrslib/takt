import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNormalOrTeamLeaderWorkflowStep } from '../core/models/types.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { loadWorkflowByIdentifier, resolveWorkflowCallTarget } from '../infra/config/loaders/workflowLoader.js';
import {
  resolveRefList,
  resolveRefListWithSource,
  resolveSectionMapWithSource,
} from '../infra/config/loaders/resource-resolver.js';

describe('policy and knowledge facet deduplication', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-facet-dedupe-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function write(relativePath: string, body: string): string {
    const path = join(projectDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    return path;
  }

  it.each(['policies', 'knowledge'] as const)('%s: keeps the first resolved file across names, aliases and paths', (kind) => {
    const context = { projectDir, lang: 'ja' as const };
    const first = `./.takt/facets/${kind}/first.md`;
    write(first, 'FIRST');
    write(`.takt/facets/${kind}/second.md`, 'SECOND');
    const sections = resolveSectionMapWithSource({ alias: first }, projectDir, kind, context);
    const refs = ['alias', 'second', 'first', first, `.takt/facets/${kind}/first.md`, 'second'];
    const resolved = resolveRefListWithSource(refs, sections, projectDir, kind, context);

    expect(resolved?.map(({ refName }) => refName)).toEqual(['alias', 'second']);
    expect(resolved?.map(({ content }) => content)).toEqual(['FIRST', 'SECOND']);
    expect(resolveRefList(refs, sections, projectDir, kind, context)).toEqual(['FIRST', 'SECOND']);
    expect(resolveRefListWithSource(['second', 'first'], sections, projectDir, kind, context)
      ?.map(({ content }) => content)).toEqual(['SECOND', 'FIRST']);
  });

  it.each(['policies', 'knowledge'] as const)('%s: keeps only the first facet across files and inline definitions with identical content', (kind) => {
    const context = { projectDir, lang: 'ja' as const };
    const first = `./.takt/facets/${kind}/first.md`;
    write(first, 'SAME');
    write(`.takt/facets/${kind}/second.md`, 'SAME');
    const sections = { inline: 'SAME', other: 'SAME' };
    const refs = ['first', 'second', 'inline', 'other', first, 'inline'];

    expect(resolveRefList(refs, sections, projectDir, kind, context)).toEqual(['SAME']);
    expect(resolveRefList(['first', 'second', 'inline', 'other'], sections, projectDir, kind, context))
      .toEqual(['SAME']);
    expect(resolveRefList([], sections, projectDir, kind, context)).toBeUndefined();
    expect(resolveRefList(undefined, sections, projectDir, kind, context)).toBeUndefined();
  });

  it.each(['policies', 'knowledge'] as const)('%s: preserves files and inline definitions with different content', (kind) => {
    const context = { projectDir, lang: 'ja' as const };
    write(`.takt/facets/${kind}/first.md`, 'FIRST');
    write(`.takt/facets/${kind}/second.md`, 'SECOND');
    const sections = { inline: 'INLINE', other: 'OTHER' };
    const refs = ['first', 'second', 'inline', 'other'];

    expect(resolveRefList(refs, sections, projectDir, kind, context))
      .toEqual(['FIRST', 'SECOND', 'INLINE', 'OTHER']);
  });

  it('preserves repeated instruction refs because their positions can express repeated actions', () => {
    const context = { projectDir, lang: 'ja' as const };
    write('.takt/facets/instructions/check.md', 'CHECK');

    expect(resolveRefList(['check', 'check'], undefined, projectDir, 'instructions', context))
      .toEqual(['CHECK', 'CHECK']);
  });

  it('preserves shared partials used in different policy contexts', () => {
    const context = { projectDir, lang: 'ja' as const };
    write('.takt/facets/partials/policies/action.md', 'ALLOW');
    write('.takt/facets/policies/first.md', 'Mode A: {{include:policies/action}}');
    write('.takt/facets/policies/second.md', 'Mode B: {{include:policies/action}}');

    expect(resolveRefList(['first', 'second', 'first'], undefined, projectDir, 'policies', context))
      .toEqual(['Mode A: ALLOW', 'Mode B: ALLOW']);
  });

  it.each(['policy', 'knowledge'] as const)('%s: deduplicates overlapping fragment and workflow params at load time and runtime', (kind) => {
    write('.takt/config.yaml', 'language: ja\n');
    const facetDir = kind === 'policy' ? 'policies' : 'knowledge';
    write(`.takt/facets/${facetDir}/first.md`, 'FIRST');
    write(`.takt/facets/${facetDir}/same-as-first.md`, 'FIRST');
    write(`.takt/facets/${facetDir}/second.md`, 'SECOND');
    write(`.takt/facets/${facetDir}/third.md`, 'THIRD');
    write('.takt/steps/review.yaml', stringify({
      params: { additions: { type: 'facet_ref[]', facet_kind: kind } },
      [kind]: ['first', { $param: 'additions' }, 'second'],
      instruction: 'Review the task.',
    }));
    const childPath = write('.takt/workflows/child.yaml', stringify({
      name: 'child',
      subworkflow: {
        callable: true,
        params: { additions: { type: 'facet_ref[]', facet_kind: kind } },
      },
      steps: [{ name: 'review', uses: 'review', with: { additions: { $param: 'additions' } },
        rules: [{ condition: 'done', next: 'COMPLETE' }] }],
    }));
    const parentPath = write('.takt/workflows/parent.yaml', stringify({
      name: 'parent',
      steps: [{ name: 'child', kind: 'workflow_call', call: 'child',
        args: { additions: ['third', 'second', `../facets/${facetDir}/same-as-first.md`, 'first'] },
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] }],
    }));
    // Loading the parent validates its child; runtime resolves the same call again.
    const parent = loadWorkflowByIdentifier(parentPath, projectDir);
    assert.ok(parent);
    const call = parent.steps[0];
    assert.ok(call?.kind === 'workflow_call');
    const runtime = resolveWorkflowCallTarget(parent, call, projectDir);
    assert.ok(runtime);
    const loaded = loadWorkflowFromFile(childPath, projectDir, { callableArgs: call.args });
    for (const workflow of [loaded, runtime]) {
      const step = workflow.steps[0];
      assert.ok(step && isNormalOrTeamLeaderWorkflowStep(step));
      const contents = kind === 'policy' ? step.policyContents : step.knowledgeContents;
      expect(contents?.map(({ content }) => content)).toEqual(['FIRST', 'THIRD', 'SECOND']);
    }
  });

});
