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

import assert from 'node:assert/strict';
import type { ResolvedFacetContent, WorkflowConfig } from '../core/models/types.js';
import { isNormalOrTeamLeaderWorkflowStep } from '../core/models/workflow-types.js';
import { loadWorkflowByIdentifier, resolveWorkflowCallTarget } from '../infra/config/loaders/workflowLoader.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  resolveRefToContent,
  type FacetResolutionContext,
} from '../infra/config/loaders/resource-resolver.js';
import { loadTemplate } from '../shared/prompts/index.js';

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

  it.each(['ja', 'en'] as const)('%s: builtin instruction includes reference existing partials', (language) => {
    const facetsRoot = fileURLToPath(new URL(`../../builtins/${language}/facets/`, import.meta.url));
    let references = 0;
    for (const directory of ['instructions', 'partials/instructions']) {
      const root = join(facetsRoot, directory);
      const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.md'));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const body = readFileSync(join(root, file), 'utf8');
        for (const match of body.matchAll(/\{\{include:instructions\/([^}]+)\}\}/g)) {
          const target = join(facetsRoot, 'partials', 'instructions', `${match[1]}.md`);
          expect(statSync(target, { throwIfNoEntry: false })?.isFile(), `${language}/${directory}/${file}: ${match[0]}`).toBe(true);
          references += 1;
        }
      }
    }
    expect(references).toBeGreaterThan(0);
  });

  it.each(['ja', 'en'] as const)('%s: grill-me expands interview partials while the assistant omits them', (lang) => {
    const grill = loadTemplate('score_interactive_system_prompt', lang, { grillMe: true });
    const assistant = loadTemplate('score_interactive_system_prompt', lang, { grillMe: false });
    for (const name of ['decision-question-priority', 'one-question-interview']) {
      const partial = readFileSync(fileURLToPath(new URL(`../../builtins/${lang}/facets/partials/instructions/${name}.md`, import.meta.url)), 'utf8').trim();
      expect(grill).toContain(partial);
      expect(assistant).not.toContain(partial);
    }
    expect(grill).not.toContain('{{include:');
  });

  it.each(['ja', 'en'] as const)('%s: review resolves its shared review procedure partial once', (lang) => {
    const reviewCommon = resolveRefToContent(
      fileURLToPath(new URL(`../../builtins/${lang}/facets/partials/policies/review-common.md`, import.meta.url)),
      undefined, tempDir, 'policies', { projectDir: tempDir, lang });
    expect(reviewCommon).toBeDefined();
    const review = resolveRefToContent('review', undefined, tempDir, 'policies', { projectDir: tempDir, lang });
    expect(review).toBeDefined();
    expect(review?.split(reviewCommon!.trim())).toHaveLength(2);
    expect(review).not.toContain('{{include:');
  });

  it.each(['ja', 'en'] as const)('%s: keeps included policies in the full snapshot and matches direct array injection', (lang) => {
    const policiesDir = join(tempDir, '.takt', 'facets', 'policies');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'policies');
    mkdirSync(policiesDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });
    writeFileSync(join(partialsDir, 'shared.md'), 'SHARED-RULE');
    writeFileSync(join(policiesDir, 'first.md'), 'FIRST-RULE\n{{include:policies/shared}}\n{{include:policies/shared}}\n' + 'a'.repeat(2_100));
    writeFileSync(join(policiesDir, 'last.md'), 'LAST-RULE');
    const policyContents = ['first', 'last'].map(name => ({
      content: resolveRefToContent(name, undefined, tempDir, 'policies', { projectDir: tempDir, lang })!,
    }));
    const combined = policyContents.map(entry => entry.content).join('\n\n---\n\n');
    const policyPath = join(tempDir, 'policies.md');
    writeFileSync(policyPath, combined);
    const step = makeStep({ policyContents });
    const instructionContext = makeInstructionContext({ language: lang, policySourcePath: policyPath });
    const direct = new InstructionBuilder(step, instructionContext).build();
    const runtime = new InstructionBuilder(step, {
      ...instructionContext,
      policyContents: [{ content: readFileSync(policyPath, 'utf8'), sourcePath: policyPath }],
    }).build();

    expect(runtime).toBe(direct);
    expect(runtime).toContain(policyPath);
    expect(readFileSync(policyPath, 'utf8')).toBe(combined);
    expect(combined).not.toContain('{{include:');
  });

  it.each(['ja', 'en'] as const)('%s: real repair workflows link resolved policy snapshots and the final-gate output contract', (lang) => {
    mkdirSync(join(tempDir, '.takt'), { recursive: true });
    writeFileSync(join(tempDir, '.takt/config.yaml'), `language: ${lang}\n`);
    const loadBuiltin = (name: string) => {
      const workflow = loadWorkflowByIdentifier(
        fileURLToPath(new URL(`../../builtins/${lang}/workflows/${name}.yaml`, import.meta.url)), tempDir);
      assert.ok(workflow, name);
      return workflow;
    };
    const childOf = (parent: WorkflowConfig, name: string) => {
      const call = parent.steps.find(step => step.name === name);
      assert.ok(call?.kind === 'workflow_call', name);
      const child = resolveWorkflowCallTarget(parent, call, tempDir, tempDir);
      assert.ok(child, name);
      return child;
    };
    const agentOf = (workflow: WorkflowConfig, name: string) => {
      const step = workflow.steps.find(step => step.name === name);
      assert.ok(step && isNormalOrTeamLeaderWorkflowStep(step), name);
      return step;
    };
    const adjudicationFixedPolicies = ['process-deviation', 'review-adjudication', 'repair-strategy', 'architecture', 'takt', 'contract-change'];
    const adjudicationPolicies = [...adjudicationFixedPolicies, 'review'];
    const stages: { step: ReturnType<typeof agentOf>; expectedPolicies: string[]; label: string }[] = [];
    for (const entry of ['peer-review', 'review-fix-simple']) {
      let peer = loadBuiltin(entry);
      if (entry === 'review-fix-simple') peer = childOf(peer, 'reviewers');
      const remediation = childOf(peer, 'remediation');
      const defaults = loadBuiltin('review-remediation');
      const planningPolicies = ['process-deviation', 'repair-strategy', 'contract-change', 'coding', 'testing', 'review',
        ...(entry === 'review-fix-simple' ? ['architecture'] : [])];
      const fixPolicies = ['repair-strategy', 'contract-change', 'coding', 'testing',
        ...(entry === 'review-fix-simple' ? ['ai-antipattern'] : [])];
      const entryStages = [
        { step: agentOf(peer, 'review-adjudication'), expectedPolicies: adjudicationPolicies },
        { step: agentOf(peer, 'final-gate'), expectedPolicies: ['process-deviation', 'repair-strategy', 'contract-change', 'coding', 'testing', 'review', 'architecture',
          ...(entry === 'peer-review' ? ['takt'] : [])] },
        ...['fix-plan', 'fix-replan', 'verification-replan', 'fix-verifier'].map(name => ({
          step: agentOf(remediation, name), expectedPolicies: planningPolicies,
        })),
        ...['fix', 'fix-retry'].map(name => ({ step: agentOf(remediation, name), expectedPolicies: fixPolicies })),
        { step: agentOf(defaults, 'review-adjudication'), expectedPolicies: [...adjudicationFixedPolicies, 'coding', 'testing', 'review'] },
      ];
      assert.equal(entryStages.length, 9);
      stages.push(...entryStages.map(stage => ({ ...stage,
        label: `${lang}/${stage.step === entryStages.at(-1)?.step ? 'review-remediation' : entry}/${stage.step.name}`,
      })));
    }
    // These parents call review-remediation; the peer-review paths above call development-remediation variants without adjudication.
    for (const { entry, planPolicies } of [
      { entry: 'simple', planPolicies: ['review', 'coding', 'testing', 'ai-antipattern'] },
      { entry: 'simple-core', planPolicies: ['review', 'coding', 'testing'] },
      { entry: 'simple-mini', planPolicies: ['coding', 'testing', 'review'] },
      { entry: 'review-fix-backend', planPolicies: ['coding', 'testing', 'review'] },
      { entry: 'review-fix-backend-cqrs', planPolicies: ['coding', 'testing', 'review', 'cqrs-es'] },
      { entry: 'review-fix-frontend', planPolicies: ['coding', 'testing', 'design-fidelity', 'review'] },
      { entry: 'review-fix-dual', planPolicies: ['coding', 'testing', 'design-fidelity', 'screen-api', 'review'] },
      { entry: 'review-fix-dual-cqrs', planPolicies: ['coding', 'testing', 'design-fidelity', 'screen-api', 'review', 'cqrs-es'] },
    ]) {
      const remediation = childOf(loadBuiltin(entry), 'remediation');
      stages.push({ step: agentOf(remediation, 'review-adjudication'),
        expectedPolicies: [...adjudicationFixedPolicies, ...planPolicies],
        label: `${lang}/${entry}/remediation/review-adjudication`,
      });
    }
    assert.equal(stages.length, 26);
    const repairPolicy = resolveRefToContent('repair-strategy', undefined, tempDir, 'policies', { projectDir: tempDir, lang });
    const finalGateFormat = resolveRefToContent('supervisor-validation', undefined, tempDir, 'output-contracts', { projectDir: tempDir, lang });
    assert.ok(repairPolicy);
    assert.ok(finalGateFormat);
    const reviewCommon = resolveRefToContent(
      fileURLToPath(new URL(`../../builtins/${lang}/facets/partials/policies/review-common.md`, import.meta.url)),
      undefined, tempDir, 'policies', { projectDir: tempDir, lang });
    assert.ok(reviewCommon);
    for (const { step, expectedPolicies, label } of stages) {
      const expectedSources = expectedPolicies.map(name => ({
        name, sourcePath: fileURLToPath(new URL(`../../builtins/${lang}/facets/policies/${name}.md`, import.meta.url)),
      }));
      const expectedSourcePaths = expectedSources.map(policy => policy.sourcePath).sort();
      const assertExactPolicies = (policies: readonly ResolvedFacetContent[] | undefined): readonly ResolvedFacetContent[] => {
        assert.ok(policies, `${label}: policyContents must exist`);
        assert.deepEqual(policies.map(policy => policy.sourcePath).sort(), expectedSourcePaths,
          `${label}: policy source paths must match exactly, including multiplicity`);
        return policies;
      };
      const policyContents = assertExactPolicies(step.policyContents);
      assertExactPolicies([...policyContents].reverse());
      assert.throws(() => assertExactPolicies(undefined), { code: 'ERR_ASSERTION', message: `${label}: policyContents must exist` });
      const extraPolicy = { content: repairPolicy, sourcePath: join(tempDir, 'policies', 'unexpected.md') };
      for (const extras of [[extraPolicy], [extraPolicy, extraPolicy]]) {
        assert.throws(() => assertExactPolicies([...policyContents, ...extras]), { code: 'ERR_ASSERTION' },
          `${label}: unexpected policies must be rejected`);
      }
      for (const { name, sourcePath } of expectedSources) {
        const missing = policyContents.filter(policy => policy.sourcePath !== sourcePath);
        assert.throws(() => assertExactPolicies(missing), { code: 'ERR_ASSERTION' }, `${label}: missing ${name}`);
        const duplicate = policyContents.find(policy => policy.sourcePath === sourcePath);
        assert.ok(duplicate);
        assert.throws(() => assertExactPolicies([...policyContents, duplicate]), { code: 'ERR_ASSERTION' },
          `${label}: duplicate ${name}`);
        const wrongSource = policyContents.map(policy => policy.sourcePath === sourcePath
          ? { ...policy, sourcePath: join(tempDir, 'policies', `${name}.md`) } : policy);
        assert.throws(() => assertExactPolicies(wrongSource), { code: 'ERR_ASSERTION' }, `${label}: wrong source for ${name}`);
      }
      expect(policyContents.filter(({ content }) => content === repairPolicy)).toHaveLength(1);
      const combined = policyContents.map(({ content }) => content).join('\n\n---\n\n');
      expect(combined).not.toContain('{{include:');
      expect(step.instruction).not.toContain('{{include:');
      if (expectedPolicies.includes('review')) {
        expect(combined.split(reviewCommon.trim()), `${label}: review-common must appear once`).toHaveLength(2);
      }
      const policyPath = join(tempDir, 'policies.md');
      writeFileSync(policyPath, combined);
      const snapshot = readFileSync(policyPath, 'utf8');
      expect(snapshot).toBe(combined);
      expect(snapshot).toContain(repairPolicy);
      const instructionContext = makeInstructionContext({
        cwd: tempDir, projectCwd: tempDir, language: lang, policySourcePath: policyPath,
      });
      const direct = new InstructionBuilder(step, instructionContext).build();
      const runtime = new InstructionBuilder(step, { ...instructionContext,
        policyContents: [{ content: snapshot, sourcePath: policyPath }],
      }).build();
      expect(runtime).toBe(direct);
      expect(runtime).toContain(policyPath);
      if (step.name === 'final-gate') {
        const report = step.outputContracts?.find(contract => 'name' in contract && contract.name === 'review-resolution.md');
        assert.ok(report && 'format' in report);
        expect(report.format).toBe(finalGateFormat);
        expect(runtime).toContain(finalGateFormat);
      }
    }
  });

  it.each(['ja', 'en'] as const)('%s: manager excludes shared interview partials and ignores their project overrides', (lang) => {
    const managerContext = { projectDir: tempDir, lang };
    const managerFacets = (['policies', 'instructions'] as const).map(kind =>
      resolveRefToContent('manager', undefined, tempDir, kind, managerContext));
    for (const facet of managerFacets) {
      expect(facet).toBeDefined();
    }
    const manager = managerFacets.join('\n\n');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'instructions');
    mkdirSync(partialsDir, { recursive: true });

    for (const name of ['decision-question-priority', 'one-question-interview']) {
      const partial = readFileSync(fileURLToPath(new URL(`../../builtins/${lang}/facets/partials/instructions/${name}.md`, import.meta.url)), 'utf8').trim();
      expect(manager).not.toContain(partial);
      writeFileSync(join(partialsDir, `${name}.md`), `Project override for ${name}`);
    }
    const managerWithOverrides = (['policies', 'instructions'] as const).map(kind =>
      resolveRefToContent('manager', undefined, tempDir, kind, managerContext));
    expect(managerWithOverrides).toEqual(managerFacets);
    expect(manager).not.toContain('{{include:');
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
