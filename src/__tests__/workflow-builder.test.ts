import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConversationGoContext } from '../features/interactive/conversationLoop.js';
import { tmpdir } from 'node:os';
import { getResourcesDir } from '../infra/resources/index.js';
import { buildBuilderChangeApproval } from '../features/workflowAuthoring/builder/approval.js';
import { buildBuilderPromptContext } from '../features/workflowAuthoring/builder/promptContext.js';
import {
  buildBuilderScopeChoices,
  listBuilderTargetWorkflows,
  resolveBuilderScope,
} from '../features/workflowAuthoring/builder/scope.js';
import { buildRelatedWorkflowAnalysis } from '../features/workflowAuthoring/builder/workflowGraph.js';
import {
  rollbackBuilderFileChanges,
} from '../features/workflowAuthoring/builder/snapshot.js';
import {
  findBuilderChangeViolation,
  resolveBuilderValidationTargets,
} from '../features/workflowAuthoring/builder/validation.js';
import {
  parseBuilderChangeManifest,
  resolveBuilderManifestChanges,
} from '../features/workflowAuthoring/builder/manifest.js';

function writeText(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function emptyApproval(target: { mode: 'create' } | { mode: 'modify'; workflowPath: string } | { mode: 'unspecified' }) {
  return {
    target,
    targetFacetPaths: [],
    approvedWorkflowPaths: [],
    approvedWorkflowFacetPaths: [],
    approvedFacetPaths: [],
  };
}

function createGoContext(userContent: string): ConversationGoContext {
  return {
    history: [{ role: 'user', content: userContent }],
    inlineText: '',
    sessionId: undefined,
    sourceContext: undefined,
    workflowContext: undefined,
    cwd: '',
    ctx: {} as ConversationGoContext['ctx'],
  };
}

function createGoContextFromHistory(history: ConversationGoContext['history']): ConversationGoContext {
  return {
    history,
    inlineText: '',
    sessionId: undefined,
    sourceContext: undefined,
    workflowContext: undefined,
    cwd: '',
    ctx: {} as ConversationGoContext['ctx'],
  };
}

function relatedWorkflowCandidates(options: Parameters<typeof buildRelatedWorkflowAnalysis>[0]) {
  return buildRelatedWorkflowAnalysis(options).candidates;
}

describe('workflow builder authoring helpers', () => {
  let projectDir: string;
  let globalDir: string;
  const previousConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-builder-project-'));
    globalDir = mkdtempSync(join(tmpdir(), 'takt-builder-global-'));
    process.env.TAKT_CONFIG_DIR = globalDir;
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
      return;
    }
    process.env.TAKT_CONFIG_DIR = previousConfigDir;
  });

  it('shows builtin scope only for the TAKT repository resources root', () => {
    expect(buildBuilderScopeChoices(projectDir).map((choice) => choice.value))
      .toEqual(['project', 'global']);

    writeText(join(projectDir, 'builtins', 'ja', 'STYLE_GUIDE.md'), '# style guide');
    mkdirSync(join(projectDir, 'builtins', 'en'), { recursive: true });

    expect(buildBuilderScopeChoices(projectDir).map((choice) => choice.value))
      .toEqual(['project', 'global']);
  });

  it('resolves builtin scope inside the TAKT repository resources root', () => {
    const taktProjectDir = dirname(getResourcesDir());

    expect(buildBuilderScopeChoices(taktProjectDir).map((choice) => choice.value))
      .toContain('builtins');
    expect(resolveBuilderScope({ projectDir: taktProjectDir, scope: 'builtins' })).toMatchObject({
      kind: 'builtins',
      roots: [
        { lang: 'en', rootDir: join(taktProjectDir, 'builtins', 'en') },
        { lang: 'ja', rootDir: join(taktProjectDir, 'builtins', 'ja') },
      ],
      writeMode: 'dual-language',
    });
  });

  it('resolves scope roots once at the builder boundary', () => {
    expect(resolveBuilderScope({ projectDir, scope: 'project' })).toMatchObject({
      kind: 'project',
      roots: [{ rootDir: join(projectDir, '.takt') }],
      writeMode: 'single-language',
    });
    expect(resolveBuilderScope({ projectDir, scope: 'global' })).toMatchObject({
      kind: 'global',
      roots: [{ rootDir: globalDir }],
      writeMode: 'single-language',
    });
    expect(() => resolveBuilderScope({ projectDir, scope: 'builtins' }))
      .toThrow('available only inside the TAKT repository');
  });

  it('lists only workflow YAML files for existing-workflow target selection', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    writeText(join(projectDir, '.takt', 'workflows', 'review.yaml'), 'name: review\n');
    writeText(join(projectDir, '.takt', 'workflows', 'draft.yml'), 'name: draft\n');
    writeText(join(projectDir, '.takt', 'workflows', 'notes.md'), '# not a workflow\n');

    expect(listBuilderTargetWorkflows(scope)).toEqual([
      { name: 'draft', path: join(projectDir, '.takt', 'workflows', 'draft.yml') },
      { name: 'review', path: join(projectDir, '.takt', 'workflows', 'review.yaml') },
    ]);
  });

  it('does not list workflow or inventory files through symlink directories', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const outsideDir = join(projectDir, 'outside-scope');
    writeText(join(outsideDir, 'workflows', 'secret.yaml'), 'name: secret\n');
    writeText(join(outsideDir, 'facets', 'personas', 'secret.md'), 'SECRET PERSONA\n');
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    symlinkSync(join(outsideDir, 'workflows'), join(projectDir, '.takt', 'workflows'), 'dir');
    symlinkSync(join(outsideDir, 'facets'), join(projectDir, '.takt', 'facets'), 'dir');

    const context = buildBuilderPromptContext({ scope, target: { mode: 'create' } });

    expect(listBuilderTargetWorkflows(scope)).toEqual([]);
    expect(context.assetInventory).not.toContain('secret.yaml');
    expect(context.assetInventory).not.toContain('secret.md');
  });

  it('rejects prompt context when the selected scope root is a symlink', () => {
    const outsideScope = join(projectDir, 'outside-scope');
    mkdirSync(outsideScope, { recursive: true });
    symlinkSync(outsideScope, join(projectDir, '.takt'), 'dir');
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });

    expect(() => buildBuilderPromptContext({ scope, target: { mode: 'create' } }))
      .toThrow(/scope root .* must not be a symlink/);
  });

  it('builds context from scope inventory and the selected workflow referenced facets', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'review.yaml');
    const personaPath = join(projectDir, '.takt', 'facets', 'personas', 'coder.md');
    writeText(join(projectDir, '.takt', 'config.yaml'), 'language: ja\n');
    writeText(personaPath, 'CODER PERSONA BODY\n');
    writeText(workflowPath, `name: review
max_steps: 10
initial_step: draft
personas:
  coder: ../facets/personas/coder.md
steps:
  - name: draft
    persona: coder
    rules:
      - condition: done
        next: COMPLETE
`);

    const context = buildBuilderPromptContext({
      scope,
      target: { mode: 'modify', workflowPath },
    });

    expect(context.scopeSummary).toContain('project');
    expect(context.assetInventory).toContain('workflows/review.yaml');
    expect(context.assetInventory).toContain('facets/personas/coder.md');
    expect(context.assetInventory).toContain('config.yaml');
    expect(context.targetContext).toContain('name: review');
    expect(context.targetContext).toContain('CODER PERSONA BODY');
  });

  it('builds context from direct path facets used by steps and loop monitors', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'direct.yaml');
    const personaPath = join(projectDir, '.takt', 'workflows', 'agents', 'main.md');
    const teamLeaderPersonaPath = join(projectDir, '.takt', 'workflows', 'agents', 'leader.md');
    const partPersonaPath = join(projectDir, '.takt', 'workflows', 'agents', 'part.md');
    const instructionPath = join(projectDir, '.takt', 'workflows', 'instructions', 'main.md');
    const policyPath = join(projectDir, '.takt', 'workflows', 'policies', 'main.md');
    const knowledgePath = join(projectDir, '.takt', 'workflows', 'knowledge', 'main.md');
    const reportFormatPath = join(projectDir, '.takt', 'workflows', 'reports', 'main.md');
    const judgePersonaPath = join(projectDir, '.takt', 'workflows', 'agents', 'judge.md');
    const judgeInstructionPath = join(projectDir, '.takt', 'workflows', 'instructions', 'judge.md');
    writeText(personaPath, 'DIRECT PERSONA BODY\n');
    writeText(teamLeaderPersonaPath, 'TEAM LEADER PERSONA BODY\n');
    writeText(partPersonaPath, 'PART PERSONA BODY\n');
    writeText(instructionPath, 'DIRECT INSTRUCTION BODY\n');
    writeText(policyPath, 'DIRECT POLICY BODY\n');
    writeText(knowledgePath, 'DIRECT KNOWLEDGE BODY\n');
    writeText(reportFormatPath, 'DIRECT REPORT FORMAT BODY\n');
    writeText(judgePersonaPath, 'JUDGE PERSONA BODY\n');
    writeText(judgeInstructionPath, 'JUDGE INSTRUCTION BODY\n');
    writeText(workflowPath, `name: direct
max_steps: 10
loop_monitors:
  - cycle: [draft, fix]
    judge:
      persona: ./agents/judge.md
      instruction: ./instructions/judge.md
      rules:
        - condition: continue
          next: draft
steps:
  - name: draft
    persona: ./agents/main.md
    team_leader:
      persona: ./agents/leader.md
      part_persona: ./agents/part.md
    instruction: ./instructions/main.md
    policy: ./policies/main.md
    knowledge: ./knowledge/main.md
    output_contracts:
      report:
        - name: report.md
          format: ./reports/main.md
    rules:
      - condition: done
        next: COMPLETE
`);

    const context = buildBuilderPromptContext({
      scope,
      target: { mode: 'modify', workflowPath },
    });
    const validationTargets = resolveBuilderValidationTargets({
      scope,
      changedWorkflowPaths: [],
      changedFacetPaths: [policyPath],
    });

    expect(context.targetContext).toContain('DIRECT PERSONA BODY');
    expect(context.targetContext).toContain('TEAM LEADER PERSONA BODY');
    expect(context.targetContext).toContain('PART PERSONA BODY');
    expect(context.targetContext).toContain('DIRECT INSTRUCTION BODY');
    expect(context.targetContext).toContain('DIRECT POLICY BODY');
    expect(context.targetContext).toContain('DIRECT KNOWLEDGE BODY');
    expect(context.targetContext).toContain('DIRECT REPORT FORMAT BODY');
    expect(context.targetContext).toContain('JUDGE PERSONA BODY');
    expect(context.targetContext).toContain('JUDGE INSTRUCTION BODY');
    expect(validationTargets).toEqual([workflowPath]);
  });

  it('does not reveal direct path facet existence outside the selected scope', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const outsideFacetPath = join(projectDir, 'secrets', 'persona.md');
    const workflowPath = join(projectDir, '.takt', 'workflows', 'outside-ref.yaml');
    writeText(outsideFacetPath, 'SECRET PERSONA BODY\n');
    writeText(workflowPath, `name: outside-ref
max_steps: 10
initial_step: draft
steps:
  - name: draft
    persona: ../../secrets/persona.md
    rules:
      - condition: done
        next: COMPLETE
`);

    const context = buildBuilderPromptContext({
      scope,
      target: { mode: 'modify', workflowPath },
    });

    expect(context.targetContext).not.toContain('SECRET PERSONA BODY');
    expect(context.targetContext).not.toContain('outside selected scope');
  });


  it('does not reveal named facet existence outside the selected scope', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const targetPath = join(projectDir, '.takt', 'workflows', 'review-main.yaml');
    const siblingPath = join(projectDir, '.takt', 'workflows', 'review-extra.yaml');
    const globalPersonaPath = join(globalDir, 'facets', 'personas', 'reviewer.md');
    writeText(targetPath, `name: review-main
max_steps: 10
initial_step: review
steps:
  - name: review
    persona: reviewer
    rules:
      - condition: done
        next: COMPLETE
`);
    writeText(siblingPath, `name: review-extra
max_steps: 10
initial_step: review
steps:
  - name: review
    persona: reviewer
    rules:
      - condition: done
        next: COMPLETE
`);

    const contextBeforeGlobalFacet = buildBuilderPromptContext({
      scope,
      target: { mode: 'modify', workflowPath: targetPath },
    });
    const candidatesBeforeGlobalFacet = relatedWorkflowCandidates({ scope, targetWorkflowPath: targetPath });

    writeText(globalPersonaPath, 'GLOBAL REVIEWER PERSONA\n');

    const context = buildBuilderPromptContext({
      scope,
      target: { mode: 'modify', workflowPath: targetPath },
    });
    const candidates = relatedWorkflowCandidates({ scope, targetWorkflowPath: targetPath });

    expect(context.targetContext).toBe(contextBeforeGlobalFacet.targetContext);
    expect(context.relatedGraph).toBe(contextBeforeGlobalFacet.relatedGraph);
    expect(context.targetContext).not.toContain('GLOBAL REVIEWER PERSONA');
    expect(context.targetContext).not.toContain(globalDir);
    expect(context.relatedGraph).not.toContain(globalDir);
    expect(context.targetContext).not.toContain('outside selected scope');
    expect(context.relatedGraph).not.toContain('outside selected scope');
    expect(candidates).toEqual(candidatesBeforeGlobalFacet);
    expect(candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'shared_facet', workflowPath: siblingPath }),
    ]));
  });

  it('does not inject a specific workflow body when target is unspecified', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    writeText(join(projectDir, '.takt', 'workflows', 'review.yaml'), `name: review
max_steps: 10
initial_step: review
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);

    const context = buildBuilderPromptContext({
      scope,
      target: { mode: 'unspecified' },
    });

    expect(context.assetInventory).toContain('workflows/review.yaml');
    expect(context.targetContext).toContain('Target mode: not narrowed yet.');
    expect(context.targetContext).toContain('ask whether the user wants to create a new workflow or modify one of them');
    expect(context.relatedGraph).toContain('workflows/review.yaml');
  });

  it('detects related workflows by shared facets and workflow_call parent-child links', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowsDir = join(projectDir, '.takt', 'workflows');
    const targetPath = join(workflowsDir, 'review-main.yaml');
    const siblingPath = join(workflowsDir, 'review-extra.yaml');
    const childPath = join(workflowsDir, 'shared', 'review-child.yaml');
    const parentPath = join(workflowsDir, 'review-parent.yaml');
    writeText(join(projectDir, '.takt', 'facets', 'personas', 'reviewer.md'), 'reviewer\n');
    writeText(targetPath, `name: review-main
max_steps: 10
initial_step: review
personas:
  reviewer: ../facets/personas/reviewer.md
steps:
  - name: review
    persona: reviewer
    rules:
      - condition: done
        next: delegate
  - name: delegate
    call: shared/review-child
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeText(siblingPath, `name: review-extra
max_steps: 10
initial_step: review
personas:
  reviewer: ../facets/personas/reviewer.md
steps:
  - name: review
    persona: reviewer
    rules:
      - condition: done
        next: COMPLETE
`);
    writeText(childPath, `name: review-child
max_steps: 10
initial_step: child
steps:
  - name: child
    rules:
      - condition: done
        next: COMPLETE
`);
    writeText(parentPath, `name: review-parent
max_steps: 10
initial_step: call-main
steps:
  - name: call-main
    call: ./review-main.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

    const candidates = relatedWorkflowCandidates({ scope, targetWorkflowPath: targetPath });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'shared_facet', workflowPath: siblingPath }),
      expect.objectContaining({ relation: 'workflow_call_child', workflowPath: childPath }),
      expect.objectContaining({ relation: 'workflow_call_parent', workflowPath: parentPath }),
    ]));
  });

  it('does not add workflow_call related candidates when the call contract is invalid', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowsDir = join(projectDir, '.takt', 'workflows');
    const targetPath = join(workflowsDir, 'review-main.yaml');
    const childPath = join(workflowsDir, 'review-child.yaml');
    writeText(targetPath, `name: review-main
max_steps: 10
initial_step: delegate
steps:
  - name: delegate
    call: ./review-child.yaml
    rules:
      - condition: retry_plan
        next: COMPLETE
`);
    writeText(childPath, `name: review-child
max_steps: 10
initial_step: child
steps:
  - name: child
    rules:
      - condition: done
        next: COMPLETE
`);

    const candidates = relatedWorkflowCandidates({ scope, targetWorkflowPath: targetPath });

    expect(candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'workflow_call_child', workflowPath: childPath }),
    ]));
  });

  it('includes workflow_call diagnostics in related graph context when call resolution fails', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const targetPath = join(projectDir, '.takt', 'workflows', 'review-main.yaml');
    writeText(targetPath, `name: review-main
max_steps: 10
initial_step: delegate
steps:
  - name: delegate
    call: ./missing-child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

    const context = buildBuilderPromptContext({
      scope,
      target: { mode: 'modify', workflowPath: targetPath },
    });

    expect(context.relatedGraph).toContain('Workflow call diagnostics:');
    expect(context.relatedGraph).toContain('Unresolved workflow_call in review-main');
  });

  it('does not mark workflows related by unused local facet mappings only', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowsDir = join(projectDir, '.takt', 'workflows');
    const targetPath = join(workflowsDir, 'review-main.yaml');
    const siblingPath = join(workflowsDir, 'review-extra.yaml');
    writeText(join(projectDir, '.takt', 'facets', 'personas', 'unused.md'), 'unused\n');
    writeText(targetPath, `name: review-main
max_steps: 10
initial_step: review
personas:
  unused: ../facets/personas/unused.md
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
    writeText(siblingPath, `name: review-extra
max_steps: 10
initial_step: review
personas:
  unused: ../facets/personas/unused.md
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);

    const candidates = relatedWorkflowCandidates({ scope, targetWorkflowPath: targetPath });

    expect(candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'shared_facet', workflowPath: siblingPath }),
    ]));
  });

  it('injects related workflow candidate bodies as untrusted context data', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const targetPath = join(projectDir, '.takt', 'workflows', 'review-main.yaml');
    const relatedPath = join(projectDir, '.takt', 'workflows', 'review-extra.yaml');
    writeText(targetPath, `name: review-main
max_steps: 10
initial_step: review
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
    writeText(relatedPath, `name: review-extra
max_steps: 10
initial_step: review
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);

    const context = buildBuilderPromptContext({
      scope,
      target: { mode: 'modify', workflowPath: targetPath },
    });

    expect(context.relatedGraph).toContain('similar_name: workflows/review-extra.yaml');
    expect(context.relatedGraph).toContain('Related workflow body: workflows/review-extra.yaml');
    expect(context.relatedGraph).toContain('name: review-extra');
  });

  it('detects workflow_call related candidates when the call uses a home-relative workflow path', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'global' });
    const parentPath = join(globalDir, 'workflows', 'parent.yaml');
    const childPath = join(globalDir, 'workflows', 'home-child.yaml');
    writeText(parentPath, `name: parent
max_steps: 10
initial_step: call-child
steps:
  - name: call-child
    call: ~/.takt/workflows/home-child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeText(childPath, `name: home-child
max_steps: 10
initial_step: done
steps:
  - name: done
    rules:
      - condition: done
        next: COMPLETE
`);

    expect(relatedWorkflowCandidates({ scope, targetWorkflowPath: parentPath }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ relation: 'workflow_call_child', workflowPath: childPath }),
      ]));
  });

  it('rejects builder file changes outside selected target approval and non-facet files inside scope', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'review.yaml');
    const facetPath = join(projectDir, '.takt', 'facets', 'personas', 'reviewer.md');
    const unapprovedWorkflowPath = join(projectDir, '.takt', 'workflows', 'unapproved.yaml');
    writeText(workflowPath, `name: review
max_steps: 10
initial_step: review
personas:
  reviewer: ../facets/personas/reviewer.md
steps:
  - name: review
    persona: reviewer
    rules:
      - condition: done
        next: COMPLETE
	`);
    writeText(facetPath, 'reviewer\n');
    writeText(unapprovedWorkflowPath, 'name: unapproved\nsteps: []\n');
    const approval = {
      ...emptyApproval({ mode: 'modify', workflowPath }),
      targetFacetPaths: [facetPath],
    };

    expect(findBuilderChangeViolation(scope, [
      { filePath: workflowPath, deleted: false },
      { filePath: facetPath, deleted: false },
    ], approval)).toBeUndefined();
    expect(findBuilderChangeViolation(scope, [
      { filePath: unapprovedWorkflowPath, deleted: false },
    ], approval)).toContain('outside the approved workflow/facet scope');
    expect(findBuilderChangeViolation(scope, [
      { filePath: join(projectDir, 'src', 'outside.ts'), deleted: false },
    ], approval)).toContain('outside the approved workflow/facet scope');
    expect(findBuilderChangeViolation(scope, [
      { filePath: join(projectDir, '.takt', 'config.yaml'), deleted: false },
    ], approval)).toContain('outside the approved workflow/facet scope');
    expect(findBuilderChangeViolation(scope, [
      { filePath: workflowPath, deleted: true },
    ], approval)).toContain('attempted to delete');
  });

  it('requires related workflow or explicit facet approval before changing shared target facets', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const targetWorkflowPath = join(projectDir, '.takt', 'workflows', 'review-main.yaml');
    const relatedWorkflowPath = join(projectDir, '.takt', 'workflows', 'review-extra.yaml');
    const facetPath = join(projectDir, '.takt', 'facets', 'personas', 'reviewer.md');
    writeText(facetPath, 'reviewer\n');
    const workflowContent = (name: string) => `name: ${name}
max_steps: 10
initial_step: review
personas:
  reviewer: ../facets/personas/reviewer.md
steps:
  - name: review
    persona: reviewer
    rules:
      - condition: done
        next: COMPLETE
`;
    writeText(targetWorkflowPath, workflowContent('review-main'));
    writeText(relatedWorkflowPath, workflowContent('review-extra'));

    const targetOnlyApproval = {
      ...emptyApproval({ mode: 'modify', workflowPath: targetWorkflowPath }),
      targetFacetPaths: [facetPath],
    };
    const relatedWorkflowApproval = {
      ...targetOnlyApproval,
      approvedWorkflowPaths: [relatedWorkflowPath],
      approvedWorkflowFacetPaths: [facetPath],
    };
    const explicitFacetApproval = {
      ...targetOnlyApproval,
      approvedFacetPaths: [facetPath],
    };

    expect(findBuilderChangeViolation(scope, [
      { filePath: facetPath, deleted: false },
    ], targetOnlyApproval)).toContain('outside the approved workflow/facet scope');
    expect(findBuilderChangeViolation(scope, [
      { filePath: facetPath, deleted: false },
    ], relatedWorkflowApproval)).toBeUndefined();
    expect(findBuilderChangeViolation(scope, [
      { filePath: facetPath, deleted: false },
    ], explicitFacetApproval)).toBeUndefined();
  });

  it('allows new workflow and facet files only under managed directories', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'created.yaml');
    const facetPath = join(projectDir, '.takt', 'facets', 'personas', 'creator.md');
    const notesPath = join(projectDir, '.takt', 'notes.md');

    expect(findBuilderChangeViolation(scope, [
      {
        filePath: workflowPath,
        deleted: false,
        created: true,
        content: `name: created
max_steps: 10
initial_step: draft
personas:
  creator: ../facets/personas/creator.md
steps:
  - name: draft
    persona: creator
    rules:
      - condition: done
        next: COMPLETE
`,
      },
      { filePath: facetPath, deleted: false, created: true, content: 'creator\n' },
    ], emptyApproval({ mode: 'create' }))).toBeUndefined();
    expect(findBuilderChangeViolation(scope, [
      { filePath: notesPath, deleted: false, created: true },
    ], emptyApproval({ mode: 'create' }))).toContain('outside the approved workflow/facet scope');
    expect(findBuilderChangeViolation(scope, [
      { filePath: notesPath, deleted: false, created: true },
    ], emptyApproval({ mode: 'unspecified' }))).toContain('outside the approved workflow/facet scope');
  });

  it('rejects builtin markdown files outside workflows and facets', () => {
    const scope = {
      kind: 'builtins' as const,
      projectDir,
      roots: [
        { lang: 'en' as const, rootDir: join(projectDir, 'builtins', 'en') },
        { lang: 'ja' as const, rootDir: join(projectDir, 'builtins', 'ja') },
      ],
      writeMode: 'dual-language' as const,
    };
    const enStyleGuidePath = join(projectDir, 'builtins', 'en', 'STYLE_GUIDE.md');

    expect(findBuilderChangeViolation(scope, [
      { filePath: enStyleGuidePath, deleted: false, created: true },
    ], emptyApproval({ mode: 'create' }))).toContain('outside the approved workflow/facet scope');
  });

  it('allows direct path facets only when referenced by the target workflow', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'direct.yaml');
    const directFacetPath = join(projectDir, '.takt', 'workflows', 'agents', 'main.md');
    const unreferencedFacetPath = join(projectDir, '.takt', 'workflows', 'agents', 'extra.md');
    writeText(directFacetPath, 'DIRECT PERSONA BODY\n');
    writeText(unreferencedFacetPath, 'EXTRA PERSONA BODY\n');
    writeText(workflowPath, `name: direct
max_steps: 10
initial_step: draft
steps:
  - name: draft
    persona: ./agents/main.md
    rules:
      - condition: done
        next: COMPLETE
`);
    const approval = buildBuilderChangeApproval({
      scope,
      target: { mode: 'modify', workflowPath },
      goContext: createGoContext(''),
    });

    expect(findBuilderChangeViolation(scope, [
      { filePath: directFacetPath, deleted: false },
    ], approval)).toBeUndefined();
    expect(findBuilderChangeViolation(scope, [
      { filePath: unreferencedFacetPath, deleted: false },
    ], approval)).toContain('outside the approved workflow/facet scope');
  });

  it('allows only explicitly approved related workflow and facet changes', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowsDir = join(projectDir, '.takt', 'workflows');
    const targetWorkflowPath = join(workflowsDir, 'review-main.yaml');
    const relatedWorkflowPath = join(workflowsDir, 'review-extra.yaml');
    const targetFacetPath = join(projectDir, '.takt', 'facets', 'personas', 'reviewer.md');
    const relatedFacetPath = join(projectDir, '.takt', 'facets', 'policies', 'extra.md');
    writeText(targetFacetPath, 'reviewer\n');
    writeText(relatedFacetPath, 'extra\n');
    writeText(targetWorkflowPath, `name: review-main
max_steps: 10
initial_step: review
personas:
  reviewer: ../facets/personas/reviewer.md
steps:
  - name: review
    persona: reviewer
    rules:
      - condition: done
        next: COMPLETE
`);
    writeText(relatedWorkflowPath, `name: review-extra
max_steps: 10
initial_step: review
policies:
  extra: ../facets/policies/extra.md
steps:
  - name: review
    policy: extra
    rules:
      - condition: done
        next: COMPLETE
`);
    const unapproved = emptyApproval({ mode: 'modify', workflowPath: targetWorkflowPath });
    const approved = {
      ...emptyApproval({ mode: 'modify', workflowPath: targetWorkflowPath }),
      approvedWorkflowPaths: [relatedWorkflowPath],
      approvedWorkflowFacetPaths: [relatedFacetPath],
    };

    expect(findBuilderChangeViolation(scope, [
      { filePath: relatedWorkflowPath, deleted: false },
    ], unapproved)).toContain('outside the approved workflow/facet scope');
    expect(findBuilderChangeViolation(scope, [
      { filePath: relatedWorkflowPath, deleted: false },
      { filePath: relatedFacetPath, deleted: false },
    ], approved)).toBeUndefined();
  });

  it('does not treat rejection text as approval for related changes', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const relatedWorkflowPath = join(projectDir, '.takt', 'workflows', 'review-extra.yaml');
    writeText(relatedWorkflowPath, 'name: review-extra\nsteps: []\n');

    const approval = buildBuilderChangeApproval({
      scope,
      target: { mode: 'modify', workflowPath: join(projectDir, '.takt', 'workflows', 'review-main.yaml') },
      goContext: createGoContext('not ok to edit review-extra.yaml'),
    });

    expect(approval.approvedWorkflowPaths).toEqual([]);
  });

  it('approves an existing workflow by extensionless workflow name in unspecified mode', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'review-main.yaml');
    writeText(workflowPath, `name: review-main
steps:
  - name: review
`);

    const approval = buildBuilderChangeApproval({
      scope,
      target: { mode: 'unspecified' },
      goContext: createGoContext('review-main を修正して'),
    });

    expect(approval.approvedWorkflowPaths).toEqual([workflowPath]);
  });

  it('approves candidates mentioned by the previous assistant message on a bare approval response', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'review-extra.yaml');
    writeText(workflowPath, `name: review-extra
steps:
  - name: review
`);

    const approval = buildBuilderChangeApproval({
      scope,
      target: { mode: 'unspecified' },
      goContext: createGoContextFromHistory([
        { role: 'assistant', content: 'Related workflow candidate: review-extra' },
        { role: 'user', content: 'はい' },
      ]),
    });

    expect(approval.approvedWorkflowPaths).toEqual([workflowPath]);
  });

  it('does not approve previous assistant candidates from clarification requests', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'review-extra.yaml');
    writeText(workflowPath, `name: review-extra
steps:
  - name: review
`);

    for (const content of [
      '変更内容を見せて',
      'review-extra.yaml の変更内容を見せて',
      '修正案を説明して',
      'show me the change plan',
      'show me the change details for review-extra.yaml',
      'explain the edit plan',
    ]) {
      const approval = buildBuilderChangeApproval({
        scope,
        target: { mode: 'unspecified' },
        goContext: createGoContextFromHistory([
          { role: 'assistant', content: 'Related workflow candidate: review-extra' },
          { role: 'user', content },
        ]),
      });

      expect(approval.approvedWorkflowPaths).toEqual([]);
    }
  });

  it('removes approval when a later user message rejects the same workflow', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'review-extra.yaml');
    writeText(workflowPath, `name: review-extra
steps:
  - name: review
`);

    const approval = buildBuilderChangeApproval({
      scope,
      target: { mode: 'modify', workflowPath: join(projectDir, '.takt', 'workflows', 'review-main.yaml') },
      goContext: createGoContextFromHistory([
        { role: 'user', content: 'OK to edit review-extra.yaml' },
        { role: 'user', content: 'do not edit review-extra.yaml' },
      ]),
    });

    expect(approval.approvedWorkflowPaths).toEqual([]);
  });

  it('approves only the candidate named in the approval segment', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const approvedWorkflowPath = join(projectDir, '.takt', 'workflows', 'review-extra.yaml');
    const skippedWorkflowPath = join(projectDir, '.takt', 'workflows', 'review-skip.yaml');
    writeText(approvedWorkflowPath, `name: review-extra
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
    writeText(skippedWorkflowPath, `name: review-skip
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);

    for (const content of [
      'OK to edit review-extra.yaml but not review-skip.yaml',
      'OK to edit review-extra.yaml but not review-skip.yaml.',
      'OK to edit review-extra.yaml, skip review-skip.yaml',
      'OK to edit review-extra.yaml; do not edit review-skip.yaml',
    ]) {
      const approval = buildBuilderChangeApproval({
        scope,
        target: { mode: 'modify', workflowPath: join(projectDir, '.takt', 'workflows', 'review-main.yaml') },
        goContext: createGoContext(content),
      });

      expect(approval.approvedWorkflowPaths).toEqual([approvedWorkflowPath]);
    }
  });

  it('does not approve a workflow whose basename is only a suffix of the approved candidate', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const targetWorkflowPath = join(projectDir, '.takt', 'workflows', 'review-main.yaml');
    const suffixWorkflowPath = join(projectDir, '.takt', 'workflows', 'flow.yaml');
    const approvedWorkflowPath = join(projectDir, '.takt', 'workflows', 'my-flow.yaml');
    writeText(targetWorkflowPath, `name: review-main
steps:
  - name: review
`);
    writeText(suffixWorkflowPath, `name: flow
steps:
  - name: review
`);
    writeText(approvedWorkflowPath, `name: my-flow
steps:
  - name: review
`);

    const approval = buildBuilderChangeApproval({
      scope,
      target: { mode: 'modify', workflowPath: targetWorkflowPath },
      goContext: createGoContext('OK to edit my-flow.yaml'),
    });

    expect(approval.approvedWorkflowPaths).toEqual([approvedWorkflowPath]);
    expect(findBuilderChangeViolation(scope, [
      { filePath: suffixWorkflowPath, deleted: false },
    ], approval)).toContain('outside the approved workflow/facet scope');
  });

  it('requires scope-relative workflow paths when approval labels are ambiguous', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const targetWorkflowPath = join(projectDir, '.takt', 'workflows', 'target.yaml');
    const rootReviewPath = join(projectDir, '.takt', 'workflows', 'review.yaml');
    const nestedReviewPath = join(projectDir, '.takt', 'workflows', 'nested', 'review.yaml');
    const workflowBody = `name: review
max_steps: 10
initial_step: done
steps:
  - name: done
    rules:
      - condition: done
        next: COMPLETE
`;
    writeText(targetWorkflowPath, workflowBody.replace('name: review', 'name: target'));
    writeText(rootReviewPath, workflowBody);
    writeText(nestedReviewPath, workflowBody.replace('name: review', 'name: nested-review'));

    const ambiguousApproval = buildBuilderChangeApproval({
      scope,
      target: { mode: 'modify', workflowPath: targetWorkflowPath },
      goContext: createGoContext('OK to edit review'),
    });
    const explicitApproval = buildBuilderChangeApproval({
      scope,
      target: { mode: 'modify', workflowPath: targetWorkflowPath },
      goContext: createGoContext('OK to edit workflows/nested/review.yaml'),
    });

    expect(ambiguousApproval.approvedWorkflowPaths).toEqual([]);
    expect(explicitApproval.approvedWorkflowPaths).toEqual([nestedReviewPath]);
  });

  it('parses builder change manifests and resolves scoped paths before writing', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const manifest = parseBuilderChangeManifest(`Before\n\n\`\`\`json
{"summary":"created review workflow","changes":[{"path":"workflows/review.yaml","content":"name: review\\nsteps: []\\n"}]}
\`\`\``);

    expect(resolveBuilderManifestChanges(projectDir, scope, manifest)).toEqual([
      {
        filePath: join(projectDir, '.takt', 'workflows', 'review.yaml'),
        deleted: false,
        created: true,
        content: 'name: review\nsteps: []\n',
      },
    ]);
  });

  it('rejects absolute paths in project, global, and builtin manifests', () => {
    const projectScope = resolveBuilderScope({ projectDir, scope: 'project' });
    const globalScope = resolveBuilderScope({ projectDir, scope: 'global' });
    const builtinScope = {
      kind: 'builtins' as const,
      projectDir,
      roots: [
        { lang: 'en' as const, rootDir: join(projectDir, 'builtins', 'en') },
        { lang: 'ja' as const, rootDir: join(projectDir, 'builtins', 'ja') },
      ],
      writeMode: 'dual-language' as const,
    };
    const projectManifest = parseBuilderChangeManifest(JSON.stringify({
      summary: 'absolute project path',
      changes: [{ path: join(projectDir, '.takt', 'workflows', 'review.yaml'), content: 'name: review\nsteps: []\n' }],
    }));
    const globalManifest = parseBuilderChangeManifest(JSON.stringify({
      summary: 'absolute global path',
      changes: [{ path: join(globalDir, 'workflows', 'review.yaml'), content: 'name: review\nsteps: []\n' }],
    }));
    const builtinManifest = parseBuilderChangeManifest(JSON.stringify({
      summary: 'absolute builtin path',
      changes: [{ path: `en:${join(projectDir, 'builtins', 'en', 'workflows', 'review.yaml')}`, content: 'name: review\nsteps: []\n' }],
    }));

    expect(() => resolveBuilderManifestChanges(projectDir, projectScope, projectManifest))
      .toThrow(/must be relative to the selected scope root/);
    expect(() => resolveBuilderManifestChanges(projectDir, globalScope, globalManifest))
      .toThrow(/must be relative to the selected scope root/);
    expect(() => resolveBuilderManifestChanges(projectDir, builtinScope, builtinManifest))
      .toThrow(/must be relative to the selected scope root/);
  });

  it('requires language-prefixed manifest paths for builtin changes', () => {
    const scope = {
      kind: 'builtins' as const,
      projectDir,
      roots: [
        { lang: 'en' as const, rootDir: join(projectDir, 'builtins', 'en') },
        { lang: 'ja' as const, rootDir: join(projectDir, 'builtins', 'ja') },
      ],
      writeMode: 'dual-language' as const,
    };
    const manifest = parseBuilderChangeManifest(JSON.stringify({
      summary: 'update builtin review workflow',
      changes: [
        { path: 'en:workflows/review.yaml', content: 'name: review\nsteps: []\n' },
        { path: 'ja:workflows/review.yaml', content: 'name: review\nsteps: []\n' },
      ],
    }));

    expect(resolveBuilderManifestChanges(projectDir, scope, manifest)).toEqual([
      {
        filePath: join(projectDir, 'builtins', 'en', 'workflows', 'review.yaml'),
        deleted: false,
        created: true,
        content: 'name: review\nsteps: []\n',
      },
      {
        filePath: join(projectDir, 'builtins', 'ja', 'workflows', 'review.yaml'),
        deleted: false,
        created: true,
        content: 'name: review\nsteps: []\n',
      },
    ]);

    const prefixlessManifest = parseBuilderChangeManifest(JSON.stringify({
      summary: 'invalid builtin manifest',
      changes: [{ path: 'workflows/review.yaml', content: 'name: review\nsteps: []\n' }],
    }));
    expect(() => resolveBuilderManifestChanges(projectDir, scope, prefixlessManifest))
      .toThrow(/must use an en: or ja: prefix/);
  });

  it('rejects manifest writes when the selected project scope root is a symlink', () => {
    const outsideScope = join(projectDir, 'outside-scope');
    mkdirSync(outsideScope, { recursive: true });
    symlinkSync(outsideScope, join(projectDir, '.takt'));
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const manifest = parseBuilderChangeManifest(JSON.stringify({
      summary: 'blocked root symlink write',
      changes: [
        { path: 'workflows/review.yaml', content: 'name: review\nsteps: []\n' },
      ],
    }));

    expect(() => resolveBuilderManifestChanges(projectDir, scope, manifest))
      .toThrow(/scope root .* must not be a symlink/);
  });

  it('rejects manifest writes through symlinked parent directories inside the selected scope', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const outsideDir = join(projectDir, 'outside-personas');
    mkdirSync(outsideDir, { recursive: true });
    mkdirSync(join(projectDir, '.takt', 'facets'), { recursive: true });
    symlinkSync(outsideDir, join(projectDir, '.takt', 'facets', 'personas'));
    const manifest = parseBuilderChangeManifest(JSON.stringify({
      summary: 'blocked symlink write',
      changes: [
        { path: 'facets/personas/reviewer.md', content: 'reviewer\n' },
      ],
    }));

    expect(() => resolveBuilderManifestChanges(projectDir, scope, manifest))
      .toThrow(/symlink component/);
  });

  it('allows new facet files referenced by a modified target workflow manifest', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'review.yaml');
    writeText(workflowPath, `name: review
max_steps: 10
initial_step: review
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
    const manifest = parseBuilderChangeManifest(JSON.stringify({
      summary: 'add reviewer persona',
      changes: [
        {
          path: 'workflows/review.yaml',
          content: `name: review
max_steps: 10
initial_step: review
personas:
  reviewer: ../facets/personas/reviewer.md
steps:
  - name: review
    persona: reviewer
    rules:
      - condition: done
        next: COMPLETE
`,
        },
        {
          path: 'facets/personas/reviewer.md',
          content: 'You are a reviewer.\n',
        },
      ],
    }));

    expect(findBuilderChangeViolation(
      scope,
      resolveBuilderManifestChanges(projectDir, scope, manifest),
      emptyApproval({ mode: 'modify', workflowPath }),
    )).toBeUndefined();
  });

  it('rejects new facet files mentioned only in workflow comments while modifying an existing workflow', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'review.yaml');
    writeText(workflowPath, `name: review
max_steps: 10
initial_step: review
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
    const manifest = parseBuilderChangeManifest(JSON.stringify({
      summary: 'add commented reviewer persona',
      changes: [
        {
          path: 'workflows/review.yaml',
          content: `name: review
max_steps: 10
initial_step: review
# ../facets/personas/reviewer.md
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`,
        },
        {
          path: 'facets/personas/reviewer.md',
          content: 'You are a reviewer.\n',
        },
      ],
    }));

    expect(findBuilderChangeViolation(
      scope,
      resolveBuilderManifestChanges(projectDir, scope, manifest),
      emptyApproval({ mode: 'modify', workflowPath }),
    )).toContain('outside the approved workflow/facet scope');
  });

  it('rejects invalid changed workflow YAML before facet approval checks', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'review.yaml');
    writeText(workflowPath, `name: review
max_steps: 10
initial_step: review
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
    const manifest = parseBuilderChangeManifest(JSON.stringify({
      summary: 'add reviewer persona with invalid workflow yaml',
      changes: [
        {
          path: 'workflows/review.yaml',
          content: 'name: [invalid\n',
        },
        {
          path: 'facets/personas/reviewer.md',
          content: 'You are a reviewer.\n',
        },
      ],
    }));

    expect(findBuilderChangeViolation(
      scope,
      resolveBuilderManifestChanges(projectDir, scope, manifest),
      emptyApproval({ mode: 'modify', workflowPath }),
    )).toContain('is not valid workflow YAML');
  });

  it('rejects new unreferenced facet files while modifying an existing workflow', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'review.yaml');
    writeText(workflowPath, `name: review
max_steps: 10
initial_step: review
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
    const manifest = parseBuilderChangeManifest(JSON.stringify({
      summary: 'add unreferenced persona',
      changes: [
        {
          path: 'workflows/review.yaml',
          content: `name: review
max_steps: 10
initial_step: review
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`,
        },
        {
          path: 'facets/personas/reviewer.md',
          content: 'You are a reviewer.\n',
        },
      ],
    }));

    expect(findBuilderChangeViolation(
      scope,
      resolveBuilderManifestChanges(projectDir, scope, manifest),
      emptyApproval({ mode: 'modify', workflowPath }),
    )).toContain('outside the approved workflow/facet scope');
  });

  it('rejects new unreferenced facet files while creating or not narrowing a workflow target', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'created.yaml');
    const facetPath = join(projectDir, '.takt', 'facets', 'personas', 'unused.md');
    const changes = [
      {
        filePath: workflowPath,
        deleted: false,
        created: true,
        content: `name: created
max_steps: 10
initial_step: draft
steps:
  - name: draft
    rules:
      - condition: done
        next: COMPLETE
`,
      },
      { filePath: facetPath, deleted: false, created: true, content: 'unused\n' },
    ];

    expect(findBuilderChangeViolation(scope, changes, emptyApproval({ mode: 'create' })))
      .toContain('outside the approved workflow/facet scope');
    expect(findBuilderChangeViolation(scope, changes, emptyApproval({ mode: 'unspecified' })))
      .toContain('outside the approved workflow/facet scope');
  });

  it('rejects invalid changed workflow content during approval checks', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowPath = join(projectDir, '.takt', 'workflows', 'review.yaml');
    writeText(workflowPath, 'name: [invalid\n');

    expect(findBuilderChangeViolation(scope, [
      { filePath: workflowPath, deleted: false, content: 'name: [invalid\n' },
    ], emptyApproval({ mode: 'modify', workflowPath }))).toContain('is not valid workflow YAML');
  });

  it('rejects builtin changes that update only one language tree', () => {
    const scope = {
      kind: 'builtins' as const,
      projectDir,
      roots: [
        { lang: 'en' as const, rootDir: join(projectDir, 'builtins', 'en') },
        { lang: 'ja' as const, rootDir: join(projectDir, 'builtins', 'ja') },
      ],
      writeMode: 'dual-language' as const,
    };
    const enWorkflowPath = join(projectDir, 'builtins', 'en', 'workflows', 'review.yaml');
    const jaWorkflowPath = join(projectDir, 'builtins', 'ja', 'workflows', 'review.yaml');
    const workflowBody = `name: review
max_steps: 10
initial_step: review
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`;
    writeText(enWorkflowPath, workflowBody);
    writeText(jaWorkflowPath, workflowBody);
    const approval = emptyApproval({ mode: 'modify', workflowPath: jaWorkflowPath });

    expect(findBuilderChangeViolation(scope, [
      { filePath: jaWorkflowPath, deleted: false },
    ], approval)).toContain('must update both builtins/en and builtins/ja');
    expect(findBuilderChangeViolation(scope, [
      { filePath: enWorkflowPath, deleted: false },
      { filePath: jaWorkflowPath, deleted: false },
    ], approval)).toBeUndefined();
  });

  it('rolls back builder file changes when a scope violation is rejected', () => {
    const workflowPath = join(projectDir, '.takt', 'workflows', 'review.yaml');
    const outsidePath = join(projectDir, 'src', 'outside.ts');
    const originalWorkflow = 'name: review\nsteps:\n  - name: review\n';
    writeText(workflowPath, originalWorkflow);
    writeText(outsidePath, 'new file\n');
    writeFileSync(workflowPath, 'changed workflow\n', 'utf-8');

    rollbackBuilderFileChanges([
      { filePath: workflowPath, beforeContent: Buffer.from(originalWorkflow) },
      { filePath: outsidePath },
    ]);

    expect(readFileSync(workflowPath, 'utf-8')).toBe(originalWorkflow);
    expect(existsSync(outsidePath)).toBe(false);
  });

  it('validates changed workflows and workflows affected by changed facets', () => {
    const scope = resolveBuilderScope({ projectDir, scope: 'project' });
    const workflowsDir = join(projectDir, '.takt', 'workflows');
    const facetPath = join(projectDir, '.takt', 'facets', 'personas', 'reviewer.md');
    const changedWorkflowPath = join(workflowsDir, 'review-main.yaml');
    const affectedWorkflowPath = join(workflowsDir, 'review-extra.yaml');
    writeText(facetPath, 'reviewer\n');
    writeText(changedWorkflowPath, `name: review-main
max_steps: 10
initial_step: review
steps:
  - name: review
    rules:
      - condition: done
        next: COMPLETE
`);
    writeText(affectedWorkflowPath, `name: review-extra
max_steps: 10
initial_step: review
personas:
  reviewer: ../facets/personas/reviewer.md
steps:
  - name: review
    persona: reviewer
    rules:
      - condition: done
        next: COMPLETE
`);

    const targets = resolveBuilderValidationTargets({
      scope,
      changedWorkflowPaths: [changedWorkflowPath],
      changedFacetPaths: [facetPath],
    });

    expect(targets).toEqual([
      affectedWorkflowPath,
      changedWorkflowPath,
    ]);
  });
});
