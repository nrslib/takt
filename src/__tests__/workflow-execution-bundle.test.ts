import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import { createPartStep } from '../core/workflow/engine/team-leader-common.js';
import { attachWorkflowOpaqueRef } from '../shared/workflowConfigMetadata.js';
import {
  loadWorkflowExecutionBundle,
  prepareWorkflowExecutionBundle,
  publishWorkflowExecutionBundle,
} from '../features/tasks/execute/workflowExecutionBundle.js';
import { attachLegacyWorkflowExecutionBundle } from '../features/workflowAuthoring/attachExecutionBundle.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workflow(name: string, steps: WorkflowConfig['steps']): WorkflowConfig {
  return attachWorkflowOpaqueRef({
    name,
    initialStep: steps[0]?.name ?? 'done',
    maxSteps: 5,
    steps,
  }, `project:sha256:${name.padEnd(64, '0').slice(0, 64)}`);
}

describe('workflow execution bundle', () => {
  it('round-trips an args-specific graph without replacing workflow_ref with node hashes', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-'));
    roots.push(root);
    const firstChild = workflow('child', [{
      name: 'one', kind: 'agent', persona: 'first prompt', personaDisplayName: 'first', instruction: '{task}',
    }]);
    const secondChild = workflow('child', [{
      name: 'two', kind: 'agent', persona: 'second prompt', personaDisplayName: 'second', instruction: '{task}',
    }]);
    const parent = workflow('parent', [
      {
        name: 'first',
        kind: 'workflow_call',
        call: 'child',
        args: {
          mode: 'first',
          personaPath: 'ordinary-persona-argument',
          partPersonaPath: 'ordinary-part-persona-argument',
        },
        personaDisplayName: 'first',
        instruction: '',
      },
      { name: 'second', kind: 'workflow_call', call: 'child', args: { mode: 'second' }, personaDisplayName: 'second', instruction: '' },
    ]);
    const prepared = prepareWorkflowExecutionBundle({
      rootWorkflow: parent,
      workflowCallResolver: ({ step }) => step.args?.mode === 'first' ? firstChild : secondChild,
      projectCwd: root,
      lookupCwd: root,
    });
    expect(Object.keys(prepared.manifest.nodes)).toHaveLength(3);

    const paths = buildRunPaths(root, 'bundle-run');
    publishWorkflowExecutionBundle(paths, prepared);
    const loaded = loadWorkflowExecutionBundle(paths);
    const [first, second] = loaded.rootWorkflow.steps;
    expect(first?.args).toEqual({
      mode: 'first',
      personaPath: 'ordinary-persona-argument',
      partPersonaPath: 'ordinary-part-persona-argument',
    });
    const loadedFirst = loaded.workflowCallResolver({
      parentWorkflow: loaded.rootWorkflow,
      step: first as never,
      projectCwd: root,
      lookupCwd: root,
    });
    const loadedSecond = loaded.workflowCallResolver({
      parentWorkflow: loaded.rootWorkflow,
      step: second as never,
      projectCwd: root,
      lookupCwd: root,
    });
    expect(loadedFirst?.steps[0]?.name).toBe('one');
    expect(loadedSecond?.steps[0]?.name).toBe('two');
    expect(getWorkflowReference(loaded.rootWorkflow)).toBe(getWorkflowReference(parent));
    expect(getWorkflowReference(loadedFirst!)).toBe(getWorkflowReference(firstChild));
    expect(Object.keys(prepared.manifest.nodes)).not.toContain(getWorkflowReference(parent));
  });

  it('fails loudly when an object is tampered', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-tamper-'));
    roots.push(root);
    const config = workflow('root', [{
      name: 'work', kind: 'agent', persona: 'prompt', personaDisplayName: 'work', instruction: '{task}',
    }]);
    const paths = buildRunPaths(root, 'tamper-run');
    publishWorkflowExecutionBundle(paths, prepareWorkflowExecutionBundle({
      rootWorkflow: config,
      workflowCallResolver: () => null,
      projectCwd: root,
      lookupCwd: root,
    }));
    const manifest = JSON.parse(readFileSync(paths.workflowBundleManifestAbs, 'utf-8')) as { nodes: Record<string, string> };
    const objectHash = Object.values(manifest.nodes)[0]!;
    const objectFile = join(paths.workflowBundleObjectsAbs, `${objectHash}.json`);
    writeFileSync(objectFile, readFileSync(objectFile, 'utf-8').replace('"name":"root"', '"name":"evil"'));
    expect(() => loadWorkflowExecutionBundle(paths)).toThrow(/integrity|hash/i);
  });

  it('rebinds a team leader part persona to the verified bundle resource', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-team-leader-'));
    roots.push(root);
    const config = workflow('root', [{
      name: 'implement',
      kind: 'agent',
      persona: 'leader step prompt',
      personaDisplayName: 'leader',
      instruction: '{task}',
      teamLeader: {
        persona: 'planning prompt',
        partPersona: 'part execution prompt',
      },
    }]);
    const paths = buildRunPaths(root, 'team-leader-run');
    publishWorkflowExecutionBundle(paths, prepareWorkflowExecutionBundle({
      rootWorkflow: config,
      workflowCallResolver: () => null,
      projectCwd: root,
      lookupCwd: root,
    }));

    const loaded = loadWorkflowExecutionBundle(paths);
    const loadedStep = loaded.rootWorkflow.steps[0]!;
    const partPersonaPath = loadedStep.teamLeader?.partPersonaPath;
    expect(dirname(partPersonaPath!)).toBe(loaded.resourceRoot);
    expect(basename(partPersonaPath!)).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(partPersonaPath!, 'utf-8')).toBe('part execution prompt');

    const partStep = createPartStep(loadedStep, {
      id: 'part-1',
      title: 'Part 1',
      instruction: 'Implement part 1',
    });
    expect(partStep.personaPath).toBe(partPersonaPath);
  });

  it('materializes and rebinds real facet personas for root-owned and inherited finding contracts', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-finding-contract-'));
    roots.push(root);
    const workflowDir = join(root, '.takt', 'workflows');
    for (const kind of ['personas', 'instructions', 'output-contracts']) {
      mkdirSync(join(root, '.takt', 'facets', kind), { recursive: true });
    }
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(root, '.takt', 'facets', 'personas', 'manager.md'), 'Resolved manager persona');
    writeFileSync(join(root, '.takt', 'facets', 'personas', 'supervisor.md'), 'Resolved adjudicator persona');
    writeFileSync(join(root, '.takt', 'facets', 'instructions', 'manager.md'), 'Resolved manager instruction');
    writeFileSync(join(root, '.takt', 'facets', 'instructions', 'adjudicate.md'), 'Resolved adjudication guidance');
    writeFileSync(join(root, '.takt', 'facets', 'output-contracts', 'manager.md'), 'Resolved manager output');
    const rawFindingContract = {
      manager: { persona: 'manager', instruction: 'manager', output_contract: 'manager' },
      adjudicator: { persona: 'supervisor', instruction: 'adjudicate' },
    };
    const context = { projectDir: root, workflowDir, lang: 'en' as const };
    const child = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
      name: 'facet-child',
      subworkflow: { callable: true, requires_finding_contract: true },
      finding_contract: rawFindingContract,
      initial_step: 'review',
      max_steps: 2,
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review.',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }, workflowDir, context), `project:sha256:${'c'.repeat(64)}`);
    const parent = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
      name: 'facet-parent',
      finding_contract: rawFindingContract,
      initial_step: 'delegate',
      max_steps: 2,
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'facet-child',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }, workflowDir, context), `project:sha256:${'p'.repeat(64)}`);
    const paths = buildRunPaths(root, 'finding-contract-bundle-run');
    const prepared = prepareWorkflowExecutionBundle({
      rootWorkflow: parent,
      workflowCallResolver: () => child,
      projectCwd: root,
      lookupCwd: root,
    });
    publishWorkflowExecutionBundle(paths, prepared);

    const loaded = loadWorkflowExecutionBundle(paths);
    const loadedChild = loaded.workflowCallResolver({
      parentWorkflow: loaded.rootWorkflow,
      step: loaded.rootWorkflow.steps[0] as never,
      projectCwd: root,
      lookupCwd: root,
    });
    for (const config of [loaded.rootWorkflow, loadedChild]) {
      const managerPath = config?.findingContract?.manager.personaPath;
      const adjudicatorPath = config?.findingContract?.adjudicator?.personaPath;
      expect(dirname(managerPath!)).toBe(loaded.resourceRoot);
      expect(dirname(adjudicatorPath!)).toBe(loaded.resourceRoot);
      expect(readFileSync(managerPath!, 'utf8')).toBe('Resolved manager persona');
      expect(readFileSync(adjudicatorPath!, 'utf8')).toBe('Resolved adjudicator persona');
    }
    expect(prepared.manifest.resources).toEqual(expect.objectContaining({
      [createHash('sha256').update('Resolved manager persona').digest('hex')]: {
        kind: 'prompt',
        size: Buffer.byteLength('Resolved manager persona'),
      },
      [createHash('sha256').update('Resolved adjudicator persona').digest('hex')]: {
        kind: 'prompt',
        size: Buffer.byteLength('Resolved adjudicator persona'),
      },
    }));
  });

  it('attaches once without changing run metadata or Finding Contract SQLite bytes', () => {
    const project = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-attach-project-'));
    const source = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-attach-source-'));
    roots.push(project, source);
    mkdirSync(join(source, 'builtins', 'en', 'workflows'), { recursive: true });
    mkdirSync(join(source, 'builtins', 'en', 'facets'), { recursive: true });
    mkdirSync(join(source, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(source, '.takt', 'workflows', 'legacy.yaml'), [
      'name: legacy',
      'max_steps: 3',
      'steps:',
      '  - name: work',
      '    persona: inline historical prompt',
      '    instruction: "{task}"',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
    ].join('\n'));
    const paths = buildRunPaths(project, 'legacy-run');
    mkdirSync(paths.runRootAbs, { recursive: true });
    const historicalRef = `project:sha256:${'a'.repeat(64)}`;
    writeFileSync(paths.metaAbs, JSON.stringify({
      task: 'legacy task',
      workflow: 'legacy',
      runSlug: 'legacy-run',
      runRoot: paths.runRootRel,
      reportDirectory: paths.reportsRel,
      contextDirectory: paths.contextRel,
      logsDirectory: paths.logsRel,
      status: 'failed',
      startTime: '2026-01-01T00:00:00.000Z',
      resume_point: {
        version: 2,
        stack: [{
          workflow: 'legacy', workflow_ref: historicalRef, step: 'work', kind: 'agent', occurrence: 1,
        }],
        iteration: 1,
        elapsed_ms: 1,
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    }));
    const findingDatabase = new DatabaseSync(paths.findingContractDatabaseAbs);
    findingDatabase.exec(`
      CREATE TABLE database_identity (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        database_instance_id TEXT NOT NULL,
        run_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE finding_authorities (
        authority_key TEXT PRIMARY KEY CHECK (length(authority_key) > 0),
        workflow_name TEXT NOT NULL CHECK (length(workflow_name) > 0),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        ledger_json TEXT NOT NULL CHECK (json_valid(ledger_json)),
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    findingDatabase.prepare(`
      INSERT INTO database_identity (
        singleton_id, database_instance_id, run_id
      ) VALUES (1, 'attach-test-instance', 'legacy-run')
    `).run();
    findingDatabase.prepare(`
      INSERT INTO finding_authorities (
        authority_key, workflow_name, revision, ledger_json, updated_at
      ) VALUES ('root', 'legacy', 3, ?, '2026-01-01T00:00:00.000Z')
    `).run(JSON.stringify({
      workflowName: 'legacy',
      nextId: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      findings: [],
      evidenceRecords: [],
      evidenceBindings: [],
      lifecycleReservations: [],
      lifecycleEvents: [],
      rawFindings: [],
      conflicts: [],
    }));
    findingDatabase.close();
    const metaBefore = readFileSync(paths.metaAbs, 'utf-8');
    const findingDatabaseBefore = readFileSync(paths.findingContractDatabaseAbs);
    const findingDatabaseHashBefore = createHash('sha256')
      .update(findingDatabaseBefore)
      .digest('hex');

    const result = attachLegacyWorkflowExecutionBundle({
      projectDir: project,
      runSlug: 'legacy-run',
      sourceRoot: source,
      rootWorkflow: '.takt/workflows/legacy.yaml',
    });

    expect(result.rootWorkflowRef).toBe(historicalRef);
    expect(readFileSync(paths.metaAbs, 'utf-8')).toBe(metaBefore);
    const findingDatabaseAfter = readFileSync(paths.findingContractDatabaseAbs);
    expect(findingDatabaseAfter.equals(findingDatabaseBefore)).toBe(true);
    expect(createHash('sha256').update(findingDatabaseAfter).digest('hex'))
      .toBe(findingDatabaseHashBefore);
    expect(getWorkflowReference(loadWorkflowExecutionBundle(paths).rootWorkflow)).toBe(historicalRef);
    expect(() => attachLegacyWorkflowExecutionBundle({
      projectDir: project,
      runSlug: 'legacy-run',
      sourceRoot: source,
      rootWorkflow: '.takt/workflows/legacy.yaml',
    })).toThrow(/already exists/);
  });

  it('rejects reusing one historical child ref for distinct same-name source workflows', () => {
    const project = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-ambiguous-project-'));
    const source = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-ambiguous-source-'));
    roots.push(project, source);
    mkdirSync(join(source, 'builtins', 'en', 'workflows'), { recursive: true });
    mkdirSync(join(source, 'builtins', 'en', 'facets'), { recursive: true });
    mkdirSync(join(source, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(source, '.takt', 'workflows', 'legacy.yaml'), [
      'name: legacy',
      'initial_step: first',
      'max_steps: 3',
      'steps:',
      '  - name: first',
      '    kind: workflow_call',
      '    call: ./child-a.yaml',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '  - name: second',
      '    kind: workflow_call',
      '    call: ./child-b.yaml',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
    ].join('\n'));
    for (const fileName of ['child-a.yaml', 'child-b.yaml']) {
      writeFileSync(join(source, '.takt', 'workflows', fileName), [
        'name: child',
        'subworkflow:',
        '  callable: true',
        'initial_step: work',
        'max_steps: 3',
        'steps:',
        '  - name: work',
        '    persona: child prompt',
        '    instruction: "{task}"',
        '    rules:',
        '      - condition: COMPLETE',
        '        next: COMPLETE',
      ].join('\n'));
    }
    const paths = buildRunPaths(project, 'ambiguous-run');
    mkdirSync(paths.runRootAbs, { recursive: true });
    const rootRef = `project:sha256:${'b'.repeat(64)}`;
    const childRef = `project:sha256:${'c'.repeat(64)}`;
    const invocationIdentity = JSON.stringify({ workflow: rootRef, step: 'first', calls: [] });
    writeFileSync(paths.metaAbs, JSON.stringify({
      task: 'ambiguous legacy task',
      workflow: 'legacy',
      runSlug: 'ambiguous-run',
      runRoot: paths.runRootRel,
      reportDirectory: paths.reportsRel,
      contextDirectory: paths.contextRel,
      logsDirectory: paths.logsRel,
      status: 'failed',
      startTime: '2026-01-01T00:00:00.000Z',
      resume_point: {
        version: 2,
        stack: [
          {
            workflow: 'legacy', workflow_ref: rootRef, step: 'first', kind: 'workflow_call', occurrence: 1, call_instance: 1,
          },
          { workflow: 'child', workflow_ref: childRef, step: 'work', kind: 'agent', occurrence: 1 },
        ],
        iteration: 1,
        elapsed_ms: 1,
        workflow_call_invocations: {
          [invocationIdentity]: {
            call_instance: 1,
            report_namespace_segment: 'iteration-1--step-first--workflow-child',
          },
        },
        workflow_step_participations: {},
      },
    }));

    expect(() => attachLegacyWorkflowExecutionBundle({
      projectDir: project,
      runSlug: 'ambiguous-run',
      sourceRoot: source,
      rootWorkflow: '.takt/workflows/legacy.yaml',
      dryRun: true,
    })).toThrow(/ambiguous across supplied source graph entities/);
  });
});
