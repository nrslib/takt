import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowConfigRawSchema } from '../core/models/workflow-schemas.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import type {
  FacetResolutionContext,
  WorkflowSections,
} from '../infra/config/loaders/resource-resolver.js';
import { resolveSectionMap } from '../infra/config/loaders/resource-resolver.js';
import { validateWorkflowReferences } from '../infra/config/loaders/workflowDoctorRefValidator.js';
import { getBuiltinFacetDir, withGlobalConfigDirOverride } from '../infra/config/paths.js';

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  readFileSyncMock.mockImplementation(actual.readFileSync);
  return { ...actual, readFileSync: readFileSyncMock };
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createWorkflow(selectorPersona = 'facet-selector', reviewerInstruction = 'select-reviewers'): Record<string, unknown> {
  return {
    name: 'selector-guidance',
    initial_step: 'implement',
    max_steps: 2,
    personas: {
      'facet-selector': 'Choose implementation facets from the supplied evidence.',
      'reviewer-selector': 'Choose reviewers from the supplied evidence.',
    },
    instructions: {
      implement: 'Implement the task.',
      review: 'Review the task.',
      'select-implementation-facets': 'Select facets using the changed paths and findings.',
      'select-reviewers': 'Select reviewers using the changed paths and reports.',
    },
    policies: {
      coding: 'Keep the implementation correct.',
    },
    facet_pools: {
      'implementation-facets': {
        candidates: [{
          id: 'frontend',
          description: 'Frontend implementation',
          policy: 'coding',
        }],
      },
    },
    steps: [
      {
        name: 'implement',
        instruction: 'implement',
        dynamic_facets: {
          pool: 'implementation-facets',
          selector: {
            persona: selectorPersona,
            instruction: 'select-implementation-facets',
          },
        },
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
      {
        name: 'reviewers',
        parallel: {
          pool: [{
            name: 'frontend',
            description: 'Review frontend changes',
            instruction: 'review',
            rules: [{ condition: 'approved', next: 'COMPLETE' }],
          }],
          selection: {
            mode: 'replace',
            selector: {
              persona: 'reviewer-selector',
              instruction: reviewerInstruction,
            },
          },
        },
        rules: [{ condition: 'all("approved")', next: 'COMPLETE' }],
      },
    ],
  };
}

function createResolutionContext(): FacetResolutionContext {
  return {
    lang: 'ja',
    workflowDir: '/project/.takt/workflows',
    projectDir: '/project',
    repertoireDir: '/repertoire',
  };
}

function createSections(raw: ReturnType<typeof WorkflowConfigRawSchema.parse>): WorkflowSections {
  const workflowDir = '/project/.takt/workflows';
  return {
    personas: raw.personas,
    resolvedInstructions: resolveSectionMap(raw.instructions, workflowDir),
    resolvedKnowledge: resolveSectionMap(raw.knowledge, workflowDir),
    resolvedPolicies: resolveSectionMap(raw.policies, workflowDir),
    resolvedReportFormats: resolveSectionMap(raw.report_formats, workflowDir),
  };
}

function createInstructionFacetWorkflow(ref: string): Record<string, unknown> {
  const workflow = createWorkflow();
  workflow.instructions = {
    implement: 'Implement the task.',
    review: 'Review the task.',
  };
  const steps = workflow.steps as Array<Record<string, unknown>>;
  const facetSelectorStep = steps[0];
  const parallelStep = steps[1];
  const facetSelector = (facetSelectorStep?.dynamic_facets as Record<string, unknown>).selector as Record<string, unknown>;
  const parallel = parallelStep?.parallel as Record<string, unknown>;
  const selection = parallel.selection as Record<string, unknown>;
  const parallelSelector = selection.selector as Record<string, unknown>;
  facetSelector.instruction = ref;
  parallelSelector.instruction = ref;
  return workflow;
}

function selectOnly(workflow: Record<string, unknown>, selector: 'facets' | 'parallel'): void {
  const steps = workflow.steps as Array<Record<string, unknown>>;
  if (selector === 'facets') {
    const parallel = steps[1]?.parallel as Record<string, unknown>;
    const selection = parallel.selection as Record<string, unknown>;
    selection.selector = undefined;
    return;
  }
  steps[0]!.dynamic_facets = undefined;
}

function normalizeInstructionFacetWorkflow(
  workflow: Record<string, unknown>,
  workflowDir: string,
  context: FacetResolutionContext,
): { facetInstruction?: string; parallelInstruction?: string } {
  const normalized = normalizeWorkflowConfig(workflow, workflowDir, context);
  const facetSelector = normalized.steps[0]?.dynamicFacets?.selector;
  const parallel = normalized.steps[1]?.parallel;
  if (parallel === undefined || Array.isArray(parallel)) {
    throw new Error('Expected a dynamic parallel step');
  }
  return {
    facetInstruction: facetSelector?.instruction,
    parallelInstruction: parallel.selection.selector?.instruction,
  };
}

describe('selector guidance resolution', () => {
  it('resolves selector guidance from project facet files and doctor accepts the references', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-resolution-'));
    roots.push(projectDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const personasDir = join(projectDir, '.takt', 'facets', 'personas');
    const instructionsDir = join(projectDir, '.takt', 'facets', 'instructions');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(personasDir, { recursive: true });
    mkdirSync(instructionsDir, { recursive: true });
    writeFileSync(join(personasDir, 'facet-selector.md'), 'Filesystem facet selector persona');
    writeFileSync(join(personasDir, 'reviewer-selector.md'), 'Filesystem reviewer selector persona');
    writeFileSync(join(instructionsDir, 'select-implementation-facets.md'), 'Filesystem facet selector instruction');
    writeFileSync(join(instructionsDir, 'select-reviewers.md'), 'Filesystem reviewer selector instruction');

    const workflow = createWorkflow();
    workflow.personas = undefined;
    workflow.instructions = {
      implement: 'Implement the task.',
      review: 'Review the task.',
    };
    const context = { projectDir, workflowDir, lang: 'ja' as const };
    const normalized = normalizeWorkflowConfig(workflow, workflowDir, context);

    const facetSelector = normalized.steps[0]?.dynamicFacets?.selector;
    expect(facetSelector).toMatchObject({
      persona: 'facet-selector',
      personaPath: join(personasDir, 'facet-selector.md'),
      instruction: 'Filesystem facet selector instruction',
    });

    const parallel = normalized.steps[1]?.parallel;
    if (parallel === undefined || Array.isArray(parallel)) {
      throw new Error('Expected a dynamic parallel step');
    }
    expect(parallel.selection.selector).toMatchObject({
      persona: 'reviewer-selector',
      personaPath: join(personasDir, 'reviewer-selector.md'),
      instruction: 'Filesystem reviewer selector instruction',
    });

    const raw = WorkflowConfigRawSchema.parse(workflow);
    const diagnostics: Array<{
      level: 'error' | 'warning';
      message: string;
      path?: readonly PropertyKey[];
    }> = [];
    validateWorkflowReferences(raw, createSections(raw), context, diagnostics);
    expect(diagnostics.filter(({ level }) => level === 'error')).toEqual([]);
  });

  it('records local selector persona and instruction references as used by doctor', () => {
    const raw = WorkflowConfigRawSchema.parse(createWorkflow());
    const diagnostics: Array<{
      level: 'error' | 'warning';
      message: string;
      path?: readonly PropertyKey[];
    }> = [];

    validateWorkflowReferences(
      raw,
      createSections(raw),
      createResolutionContext(),
      diagnostics,
    );

    expect(diagnostics.filter(({ level }) => level === 'error')).toEqual([]);
    const warnings = diagnostics
      .filter(({ level }) => level === 'warning')
      .map(({ message }) => message);
    expect(warnings).not.toContain('Unused personas entry "facet-selector"');
    expect(warnings).not.toContain('Unused personas entry "reviewer-selector"');
    expect(warnings).not.toContain('Unused instructions entry "select-implementation-facets"');
    expect(warnings).not.toContain('Unused instructions entry "select-reviewers"');
  });

  it('resolves named persona and instruction facets into both selector configurations', () => {
    const workflow = normalizeWorkflowConfig(
      createWorkflow(),
      '/project/.takt/workflows',
      { projectDir: '/project', workflowDir: '/project/.takt/workflows', lang: 'ja' },
    );

    const facetSelector = workflow.steps[0]?.dynamicFacets as unknown as {
      selector?: { persona?: string; instruction?: string };
    };
    expect(facetSelector.selector).toEqual({
      persona: 'Choose implementation facets from the supplied evidence.',
      instruction: 'Select facets using the changed paths and findings.',
    });

    const parallel = workflow.steps[1]?.parallel;
    if (parallel === undefined || Array.isArray(parallel)) {
      throw new Error('Expected a dynamic parallel step');
    }
    const selection = parallel.selection as unknown as {
      selector?: { persona?: string; instruction?: string };
    };
    expect(selection.selector).toEqual({
      persona: 'Choose reviewers from the supplied evidence.',
      instruction: 'Select reviewers using the changed paths and reports.',
    });
  });

  it('resolves a .md selector instruction reference from the section map before filesystem paths', () => {
    const workflow = createInstructionFacetWorkflow('select.md');
    workflow.instructions = {
      implement: 'Implement the task.',
      review: 'Review the task.',
      'select.md': 'Use schema.md',
    };

    const result = normalizeInstructionFacetWorkflow(
      workflow,
      '/project/.takt/workflows',
      { projectDir: '/project', workflowDir: '/project/.takt/workflows', lang: 'ja' },
    );

    expect(result).toEqual({
      facetInstruction: 'Use schema.md',
      parallelInstruction: 'Use schema.md',
    });
  });

  it('resolves a map entry whose .md value points inside the instruction facet root', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-map-file-'));
    roots.push(projectDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const instructionsDir = join(projectDir, '.takt', 'facets', 'instructions');
    const guidancePath = join(instructionsDir, 'guidance.md');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(instructionsDir, { recursive: true });
    writeFileSync(guidancePath, 'Instruction facet selector guidance');

    const workflow = createInstructionFacetWorkflow('select.md');
    workflow.instructions = {
      implement: 'Implement the task.',
      review: 'Review the task.',
      'select.md': relative(workflowDir, guidancePath),
    };

    const result = normalizeInstructionFacetWorkflow(
      workflow,
      workflowDir,
      { projectDir, workflowDir, lang: 'ja' },
    );

    expect(result).toEqual({
      facetInstruction: 'Instruction facet selector guidance',
      parallelInstruction: 'Instruction facet selector guidance',
    });
  });

  it('rejects a direct selector instruction resource path without a .md extension', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-direct-extension-'));
    roots.push(projectDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });

    expect(() => normalizeInstructionFacetWorkflow(
      createInstructionFacetWorkflow('./guide.txt'),
      workflowDir,
      { projectDir, workflowDir, lang: 'ja' },
    )).toThrow('Selector instruction resource path must use a .md file: ./guide.txt');
  });

  it('rejects a selector instruction map value without a .md extension', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-map-extension-'));
    roots.push(projectDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });

    const workflow = createInstructionFacetWorkflow('select.md');
    workflow.instructions = {
      implement: 'Implement the task.',
      review: 'Review the task.',
      'select.md': './guide.txt',
    };

    expect(() => normalizeInstructionFacetWorkflow(
      workflow,
      workflowDir,
      { projectDir, workflowDir, lang: 'ja' },
    )).toThrow('Selector instruction resource path must use a .md file: ./guide.txt');
  });

  it.each(['facets', 'parallel'] as const)('rejects %s selector map sources when the referenced file is missing', (selector) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-map-missing-'));
    roots.push(projectDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const instructionsDir = join(projectDir, '.takt', 'facets', 'instructions');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(instructionsDir, { recursive: true });

    const missingPath = join(instructionsDir, 'missing.md');
    const workflow = createInstructionFacetWorkflow('select.md');
    workflow.instructions = {
      implement: 'Implement the task.',
      review: 'Review the task.',
      'select.md': relative(workflowDir, missingPath),
    };
    selectOnly(workflow, selector);

    expect(() => normalizeWorkflowConfig(workflow, workflowDir, {
      projectDir,
      workflowDir,
      lang: 'ja',
    })).toThrow(/Facet resource file not found/);
  });

  it.each(['facets', 'parallel'] as const)('rejects %s selector map sources outside the instruction facet root by relative path', (selector) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-map-outside-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-map-outside-file-'));
    roots.push(projectDir, outsideDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const outsidePath = join(outsideDir, 'secret.md');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(outsidePath, 'SECRET-OUTSIDE-INSTRUCTION-ROOT');

    const workflow = createInstructionFacetWorkflow('select.md');
    workflow.instructions = {
      implement: 'Implement the task.',
      review: 'Review the task.',
      'select.md': relative(workflowDir, outsidePath),
    };
    selectOnly(workflow, selector);

    readFileSyncMock.mockClear();
    expect(() => normalizeWorkflowConfig(workflow, workflowDir, {
      projectDir,
      workflowDir,
      lang: 'ja',
    })).toThrow(/Selector instruction file must stay inside an allowed instruction facet root/);
    expect(readFileSyncMock.mock.calls.some(([path]) => path === outsidePath)).toBe(false);
  });

  it.each(['facets', 'parallel'] as const)('rejects %s selector map sources outside the instruction facet root by absolute path', (selector) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-map-absolute-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-map-absolute-file-'));
    roots.push(projectDir, outsideDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const outsidePath = join(outsideDir, 'secret.md');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(outsidePath, 'SECRET-OUTSIDE-INSTRUCTION-ROOT');

    const workflow = createInstructionFacetWorkflow('select.md');
    workflow.instructions = {
      implement: 'Implement the task.',
      review: 'Review the task.',
      'select.md': outsidePath,
    };
    selectOnly(workflow, selector);

    readFileSyncMock.mockClear();
    expect(() => normalizeWorkflowConfig(workflow, workflowDir, {
      projectDir,
      workflowDir,
      lang: 'ja',
    })).toThrow(/Selector instruction file must stay inside an allowed instruction facet root/);
    expect(readFileSyncMock.mock.calls.some(([path]) => path === outsidePath)).toBe(false);
  });

  it.each(['facets', 'parallel'] as const)('rejects %s selector map sources using an external symlink', (selector) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-map-symlink-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-map-symlink-file-'));
    roots.push(projectDir, outsideDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const secretPath = join(outsideDir, 'secret.md');
    const symlinkPath = join(outsideDir, 'selector-link.md');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(secretPath, 'SECRET-OUTSIDE-INSTRUCTION-ROOT');
    symlinkSync(secretPath, symlinkPath, 'file');

    const workflow = createInstructionFacetWorkflow('select.md');
    workflow.instructions = {
      implement: 'Implement the task.',
      review: 'Review the task.',
      'select.md': relative(workflowDir, symlinkPath),
    };
    selectOnly(workflow, selector);

    readFileSyncMock.mockClear();
    expect(() => normalizeWorkflowConfig(workflow, workflowDir, {
      projectDir,
      workflowDir,
      lang: 'ja',
    })).toThrow(/Selector instruction file must stay inside an allowed instruction facet root/);
    expect(readFileSyncMock.mock.calls.some(([path]) => path === symlinkPath)).toBe(false);
  });

  it.each(['facets', 'parallel'] as const)('rejects %s selector map sources when an in-root symlink points outside', (selector) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-map-inroot-symlink-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-map-inroot-symlink-file-'));
    roots.push(projectDir, outsideDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const instructionsDir = join(projectDir, '.takt', 'facets', 'instructions');
    const secretPath = join(outsideDir, 'secret.md');
    const symlinkPath = join(instructionsDir, 'selector-link.md');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(instructionsDir, { recursive: true });
    writeFileSync(secretPath, 'SECRET-OUTSIDE-INSTRUCTION-ROOT');
    symlinkSync(secretPath, symlinkPath, 'file');

    const workflow = createInstructionFacetWorkflow('select.md');
    workflow.instructions = {
      implement: 'Implement the task.',
      review: 'Review the task.',
      'select.md': relative(workflowDir, symlinkPath),
    };
    selectOnly(workflow, selector);

    readFileSyncMock.mockClear();
    expect(() => normalizeWorkflowConfig(workflow, workflowDir, {
      projectDir,
      workflowDir,
      lang: 'ja',
    })).toThrow(/Selector instruction file .*symlink/);
    expect(readFileSyncMock.mock.calls.some(([path]) => path === symlinkPath)).toBe(false);
    expect(readFileSyncMock.mock.calls.some(([path]) => path === secretPath)).toBe(false);
  });

  it('fails fast when a .md selector instruction is absent from the map and filesystem', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-missing-'));
    roots.push(projectDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const instructionsDir = join(projectDir, '.takt', 'facets', 'instructions');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(instructionsDir, { recursive: true });

    const missingPath = join(instructionsDir, 'missing.md');
    expect(() => normalizeInstructionFacetWorkflow(
      createInstructionFacetWorkflow(relative(workflowDir, missingPath)),
      workflowDir,
      { projectDir, workflowDir, lang: 'ja' },
    )).toThrow(/Selector instruction file not found/);
  });

  it('fails fast when a whitespace-free named selector instruction is unresolved', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-named-missing-'));
    roots.push(projectDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });

    expect(() => normalizeInstructionFacetWorkflow(
      createInstructionFacetWorkflow('missing-selector-instruction'),
      workflowDir,
      { projectDir, workflowDir, lang: 'ja' },
    )).toThrow('selector.instruction could not be resolved: missing-selector-instruction');
  });

  it('fails fast when a scoped selector instruction is unresolved', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-scoped-instruction-'));
    roots.push(root);
    const projectDir = join(root, 'project');
    const repertoireDir = join(root, 'repertoire');
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });

    expect(() => normalizeInstructionFacetWorkflow(
      createInstructionFacetWorkflow('@owner/repo/missing-selector'),
      workflowDir,
      { projectDir, workflowDir, repertoireDir, lang: 'ja' },
    )).toThrow('selector.instruction could not be resolved: @owner/repo/missing-selector');
  });

  it('keeps whitespace-containing selector guidance as inline content', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-inline-'));
    roots.push(projectDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    const instruction = 'Select reviewers using changed paths';

    expect(normalizeInstructionFacetWorkflow(
      createInstructionFacetWorkflow(instruction),
      workflowDir,
      { projectDir, workflowDir, lang: 'ja' },
    )).toEqual({
      facetInstruction: instruction,
      parallelInstruction: instruction,
    });
  });

  it('fails fast when a scoped selector persona is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-scoped-persona-'));
    roots.push(root);
    const projectDir = join(root, 'project');
    const repertoireDir = join(root, 'repertoire');
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });

    expect(() => normalizeWorkflowConfig(
      createWorkflow('@owner/repo/missing-selector'),
      workflowDir,
      { projectDir, workflowDir, repertoireDir, lang: 'ja' },
    )).toThrow('selector.persona could not be resolved: @owner/repo/missing-selector');
  });

  it('reports missing selector facet references with their configuration paths', () => {
    const raw = WorkflowConfigRawSchema.parse(createWorkflow('missing-selector', 'missing-instruction'));
    const diagnostics: Array<{
      level: 'error' | 'warning';
      message: string;
      path?: readonly PropertyKey[];
    }> = [];

    validateWorkflowReferences(
      raw,
      createSections(raw),
      createResolutionContext(),
      diagnostics,
    );

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'error',
        path: ['steps', 0, 'dynamic_facets', 'selector', 'persona'],
      }),
      expect.objectContaining({
        level: 'error',
        path: ['steps', 1, 'parallel', 'selection', 'selector', 'instruction'],
      }),
    ]));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      message: 'step "reviewers" selector instruction references missing resource "missing-instruction"',
    }));
  });

  it('includes selector instruction resolution errors in doctor diagnostics', () => {
    const raw = WorkflowConfigRawSchema.parse(createInstructionFacetWorkflow('select-guidance'));
    const sections = createSections(raw);
    sections.resolvedInstructionsWithSource = {
      'select-guidance': {
        content: 'outside instruction',
        sourcePath: '/outside/selector.md',
      },
    };
    const diagnostics: Array<{
      level: 'error' | 'warning';
      message: string;
      path?: readonly PropertyKey[];
    }> = [];

    validateWorkflowReferences(raw, sections, createResolutionContext(), diagnostics);

    expect(diagnostics.some(({ message }) => (
      message.includes('step "implement" selector instruction references missing resource "select-guidance"')
      && message.includes('Selector instruction file must stay inside an allowed instruction facet root')
    ))).toBe(true);
  });

  it('resolves a selector instruction from the project facet root by path', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-project-'));
    roots.push(projectDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const instructionPath = join(projectDir, '.takt', 'facets', 'instructions', 'path-selector.md');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(join(projectDir, '.takt', 'facets', 'instructions'), { recursive: true });
    writeFileSync(instructionPath, 'Project selector instruction by path');

    const result = normalizeInstructionFacetWorkflow(
      createInstructionFacetWorkflow(relative(workflowDir, instructionPath)),
      workflowDir,
      { projectDir, workflowDir, lang: 'ja' },
    );

    expect(result).toEqual({
      facetInstruction: 'Project selector instruction by path',
      parallelInstruction: 'Project selector instruction by path',
    });
  });

  it('resolves a selector instruction from the global facet root by path', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-project-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-global-'));
    roots.push(projectDir, globalConfigDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const instructionPath = join(globalConfigDir, 'facets', 'instructions', 'path-selector.md');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(join(globalConfigDir, 'facets', 'instructions'), { recursive: true });
    writeFileSync(instructionPath, 'Global selector instruction by path');

    const result = withGlobalConfigDirOverride(globalConfigDir, () => normalizeInstructionFacetWorkflow(
      createInstructionFacetWorkflow(relative(workflowDir, instructionPath)),
      workflowDir,
      { projectDir, workflowDir, lang: 'ja' },
    ));

    expect(result).toEqual({
      facetInstruction: 'Global selector instruction by path',
      parallelInstruction: 'Global selector instruction by path',
    });
  });

  it('resolves a selector instruction from the builtin facet root by path', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-project-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-global-'));
    roots.push(projectDir, globalConfigDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    const instructionPath = join(getBuiltinFacetDir('ja', 'instructions'), 'apply-fix-plan.md');

    const result = withGlobalConfigDirOverride(globalConfigDir, () => normalizeInstructionFacetWorkflow(
      createInstructionFacetWorkflow(relative(workflowDir, instructionPath)),
      workflowDir,
      { projectDir, workflowDir, lang: 'ja' },
    ));

    const expectedInstruction = readFileSync(instructionPath, 'utf8');
    const stableLine = expectedInstruction
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('{{include:'));
    if (stableLine === undefined) {
      throw new Error('Expected the builtin instruction to contain a non-include line');
    }
    expect(result.facetInstruction).toContain(stableLine);
    expect(result.parallelInstruction).toBe(result.facetInstruction);
  });

  it('resolves a selector instruction from a repertoire package facet root by path', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-repertoire-'));
    roots.push(root);
    const projectDir = join(root, 'project');
    const repertoireDir = join(root, 'repertoire');
    const workflowDir = join(repertoireDir, '@owner', 'repo', 'workflows');
    const instructionPath = join(repertoireDir, '@owner', 'repo', 'facets', 'instructions', 'path-selector.md');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(join(repertoireDir, '@owner', 'repo', 'facets', 'instructions'), { recursive: true });
    writeFileSync(instructionPath, 'Repertoire selector instruction by path');

    const result = normalizeInstructionFacetWorkflow(
      createInstructionFacetWorkflow(relative(workflowDir, instructionPath)),
      workflowDir,
      { projectDir, workflowDir, repertoireDir, lang: 'ja' },
    );

    expect(result).toEqual({
      facetInstruction: 'Repertoire selector instruction by path',
      parallelInstruction: 'Repertoire selector instruction by path',
    });
  });

  it.each(['facets', 'parallel'] as const)('rejects %s selector traversal before reading outside the project', (selector) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-project-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-outside-'));
    roots.push(projectDir, outsideDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const outsidePath = join(outsideDir, 'secret.md');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(outsidePath, 'SECRET-OUTSIDE-PROJECT');
    const workflow = createInstructionFacetWorkflow(relative(workflowDir, outsidePath));
    selectOnly(workflow, selector);

    expect(() => normalizeWorkflowConfig(workflow, workflowDir, {
      projectDir,
      workflowDir,
      lang: 'ja',
    })).toThrow(/Selector instruction file must stay inside an allowed instruction facet root/);
  });

  it.each(['facets', 'parallel'] as const)('rejects %s selector absolute paths before reading outside the project', (selector) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-project-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-outside-'));
    roots.push(projectDir, outsideDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const outsidePath = join(outsideDir, 'secret.md');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(outsidePath, 'SECRET-OUTSIDE-PROJECT');
    const workflow = createInstructionFacetWorkflow(outsidePath);
    selectOnly(workflow, selector);

    expect(() => normalizeWorkflowConfig(workflow, workflowDir, {
      projectDir,
      workflowDir,
      lang: 'ja',
    })).toThrow(/Selector instruction file must stay inside an allowed instruction facet root/);
  });

  it.each(['facets', 'parallel'] as const)('rejects %s selector symlinks that point outside the project', (selector) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-project-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-outside-'));
    roots.push(projectDir, outsideDir);
    const workflowDir = join(projectDir, '.takt', 'workflows');
    const instructionsDir = join(projectDir, '.takt', 'facets', 'instructions');
    const outsidePath = join(outsideDir, 'secret.md');
    const symlinkPath = join(instructionsDir, 'selector-link.md');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(instructionsDir, { recursive: true });
    writeFileSync(outsidePath, 'SECRET-OUTSIDE-PROJECT');
    symlinkSync(outsidePath, symlinkPath, 'file');
    const workflow = createInstructionFacetWorkflow(relative(workflowDir, symlinkPath));
    selectOnly(workflow, selector);

    expect(() => normalizeWorkflowConfig(workflow, workflowDir, {
      projectDir,
      workflowDir,
      lang: 'ja',
    })).toThrow(/Selector instruction file .*symlink/);
  });
});
