import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServerConfig, WorkflowConfig } from '../core/models/index.js';
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
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { buildWorkflowStepParticipationIdentity } from '../core/workflow/workflow-step-participation-index.js';
import { canonicalJson } from '../shared/utils/canonical-json.js';

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

function mcpAgentWorkflow(
  name: string,
  mcpServers: Record<string, McpServerConfig>,
): WorkflowConfig {
  return workflow(name, [{
    name: 'work',
    kind: 'agent',
    persona: 'prompt',
    personaDisplayName: 'work',
    instruction: '{task}',
    mcpServers,
  }]);
}

function withMcpServers(
  config: WorkflowConfig,
  mcpServers: Record<string, McpServerConfig>,
): WorkflowConfig {
  const copy = structuredClone(config);
  const step = copy.steps[0];
  if (step === undefined || step.kind === 'system' || step.kind === 'workflow_call') {
    throw new Error('Expected an agent step');
  }
  step.mcpServers = mcpServers;
  return copy;
}

function prepareCentralBundle(root: string, rootWorkflow: WorkflowConfig) {
  return prepareWorkflowExecutionBundle({
    rootWorkflow,
    workflowCallResolver: () => null,
    projectCwd: root,
    lookupCwd: root,
    centralExecution: true,
  });
}

describe('workflow execution bundle', () => {
  it('restores normalized workflow-wide rules after the source rule file is removed', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-rules-'));
    roots.push(root);
    const workflowDir = join(root, '.takt', 'workflows');
    const rulePath = join(workflowDir, 'rules', 'bundle-rule.md');
    const workflowPath = join(workflowDir, 'root.yaml');
    mkdirSync(join(workflowDir, 'rules'), { recursive: true });
    writeFileSync(rulePath, 'BUNDLE_RULE_BODY', 'utf-8');
    writeFileSync(workflowPath, `name: root
initial_step: work
max_steps: 1
all_steps:
  rules:
    - bundle-rule
steps:
  - name: work
    persona: coder
    instruction: Work
`, 'utf-8');

    const config = loadWorkflowFromFile(workflowPath, root);
    const originalRules = (config as unknown as {
      readonly allStepsRules: readonly unknown[];
    }).allStepsRules;
    expect(originalRules).toEqual([{
      ref: 'bundle-rule',
      position: 'after_execution_rules',
      content: 'BUNDLE_RULE_BODY',
    }]);

    const paths = buildRunPaths(root, 'bundle-rules-run');
    publishWorkflowExecutionBundle(paths, prepareWorkflowExecutionBundle({
      rootWorkflow: config,
      workflowCallResolver: () => null,
      projectCwd: root,
      lookupCwd: root,
    }));
    rmSync(rulePath);

    const loaded = loadWorkflowExecutionBundle(paths);
    expect((loaded.rootWorkflow as unknown as {
      readonly allStepsRules: readonly unknown[];
    }).allStepsRules).toEqual(originalRules);
  });

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
      {
        name: 'second',
        kind: 'workflow_call',
        call: 'child',
        args: {
          mode: 'second',
          companions: {
            fixed: ['reviewer'],
            pool: [],
            moderator: 'moderator',
          },
        },
        personaDisplayName: 'second',
        instruction: '',
      },
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
    const firstCall = first as { readonly args?: unknown } | undefined;
    const secondCall = second as { readonly args?: unknown } | undefined;
    expect(firstCall?.args).toEqual({
      mode: 'first',
      personaPath: 'ordinary-persona-argument',
      partPersonaPath: 'ordinary-part-persona-argument',
    });
    expect(secondCall?.args).toEqual({
      mode: 'second',
      companions: {
        fixed: ['reviewer'],
        pool: [],
        moderator: 'moderator',
      },
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

  it('rejects an invalid companion selection at the bundle argument boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-arg-boundary-'));
    roots.push(root);
    const child = workflow('child', [{
      name: 'one', kind: 'agent', persona: 'child prompt', personaDisplayName: 'child', instruction: '{task}',
    }]);
    const parent = workflow('parent', [{
      name: 'delegate',
      kind: 'workflow_call',
      call: 'child',
      args: {
        companions: {
          fixed: ['reviewer'],
          pool: [],
          moderator: 'moderator',
        },
      },
      personaDisplayName: 'delegate',
      instruction: '',
    }]);
    const paths = buildRunPaths(root, 'bundle-arg-boundary-run');
    publishWorkflowExecutionBundle(paths, prepareWorkflowExecutionBundle({
      rootWorkflow: parent,
      workflowCallResolver: () => child,
      projectCwd: root,
      lookupCwd: root,
    }));

    const manifest = JSON.parse(readFileSync(paths.workflowBundleManifestAbs, 'utf-8')) as {
      nodes: Record<string, string>;
      root: { nodeId: string };
    };
    const rootHash = manifest.nodes[manifest.root!.nodeId];
    if (rootHash === undefined) throw new Error('Root bundle node is missing');
    const objectPath = join(paths.workflowBundleObjectsAbs, `${rootHash}.json`);
    const object = JSON.parse(readFileSync(objectPath, 'utf-8')) as {
      calls: Array<{ args: Record<string, unknown> }>;
    };
    object.calls[0]!.args.companions = {
      fixed: ['reviewer'],
      pool: [],
      moderator: 'reviewer',
    };
    const encoded = canonicalJson(object);
    const replacementHash = createHash('sha256').update(encoded).digest('hex');
    writeFileSync(join(paths.workflowBundleObjectsAbs, `${replacementHash}.json`), `${encoded}\n`);
    rmSync(objectPath);
    manifest.nodes[manifest.root!.nodeId] = replacementHash;
    const manifestText = canonicalJson(manifest);
    writeFileSync(paths.workflowBundleManifestAbs, `${manifestText}\n`);
    writeFileSync(
      paths.workflowBundleManifestHashAbs,
      `${createHash('sha256').update(manifestText).digest('hex')}\n`,
    );

    expect(() => loadWorkflowExecutionBundle(paths)).toThrow('argument "companions" is invalid');
  });

  it('requires references only for credential-bearing MCP env and headers', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-mcp-env-'));
    roots.push(root);
    const centralWorkflow = mcpAgentWorkflow('central-mcp', {
      stdio: {
        command: 'mcp-server',
        env: {
          LOG_LEVEL: 'debug',
          NODE_ENV: 'test',
          ENDPOINT: 'https://example.test/mcp',
          API_KEY: '${MCP_API_KEY}',
        },
      },
      http: {
        type: 'http',
        url: 'https://example.test/mcp?version=2',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': 'request-id',
          Authorization: '${MCP_TOKEN}',
        },
      },
    });

    const prepared = prepareCentralBundle(root, centralWorkflow);
    const serialized = [...prepared.objects.values()].join('\n');
    expect(serialized).toContain('${MCP_API_KEY}');
    expect(serialized).toContain('debug');
    expect(serialized).toContain('application/json');
    expect(serialized).not.toContain('literal-secret');

    const literalEnvWorkflow = withMcpServers(centralWorkflow, {
      stdio: {
        command: 'mcp-server',
        env: { API_KEY: 'literal-secret' },
      },
    });
    expect(() => prepareCentralBundle(root, literalEnvWorkflow)).toThrow(/unsafe MCP value/i);

    const mixedHeaderWorkflow = withMcpServers(centralWorkflow, {
      http: {
        type: 'http',
        url: 'https://example.test/mcp',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ${MCP_TOKEN}',
        },
      },
    });
    expect(() => prepareCentralBundle(root, mixedHeaderWorkflow)).toThrow(/unsafe MCP value/i);

    expect(() => prepareWorkflowExecutionBundle({
      rootWorkflow: literalEnvWorkflow,
      workflowCallResolver: () => null,
      projectCwd: root,
      lookupCwd: root,
    })).not.toThrow();
  });

  it('allows ordinary MCP arguments while protecting credential flags', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-mcp-args-'));
    roots.push(root);
    const baseWorkflow = mcpAgentWorkflow('central-mcp-args', {
      safe: { command: 'npx', args: [] },
    });
    const withArgs = (args: string[]): WorkflowConfig => withMcpServers(baseWorkflow, {
      safe: { command: 'npx', args },
    });

    expect(() => prepareCentralBundle(root, withArgs([
      '-y',
      '-h',
      '@modelcontextprotocol/server-filesystem',
      'serve',
      '--transport=stdio',
      '--API_KEY=${MCP_TOKEN}',
      '--authorization:${MCP_AUTHORIZATION}',
      '--headerish=ordinary-value',
    ]))).not.toThrow();

    for (const args of [
      ['--API_KEY=literal-secret'],
      ['--api_key=Bearer ${MCP_TOKEN}'],
      ['-Hliteral-secret'],
      ['-HAuthorization:literal-secret'],
      ['-H=literal-secret'],
      ['-H:literal-secret'],
      ['-H', 'literal-secret'],
      ['--auth-header=literal-secret'],
      ['--custom-header:literal-secret'],
      ['--authorization-header', 'literal-secret'],
    ]) {
      expect(() => prepareCentralBundle(root, withArgs(args))).toThrow(/unsafe MCP value/i);
    }

    for (const args of [
      ['-H${MCP_HEADER}'],
      ['-H=${MCP_HEADER}'],
      ['-H:${MCP_HEADER}'],
      ['-H', '${MCP_HEADER}'],
      ['--auth-header=${MCP_AUTH_HEADER}'],
      ['--custom-header:${MCP_CUSTOM_HEADER}'],
      ['--authorization-header', '${MCP_AUTHORIZATION_HEADER}'],
    ]) {
      expect(() => prepareCentralBundle(root, withArgs(args))).not.toThrow();
    }

    expect(() => prepareCentralBundle(root, withArgs(['-h=help']))).not.toThrow();
  });

  it('rejects only credential-bearing MCP URL parts', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-mcp-url-'));
    roots.push(root);
    const withUrl = (url: string): WorkflowConfig => mcpAgentWorkflow('central-mcp-url', {
      safe: { type: 'http', url },
    });

    for (const url of [
      'https://example.test/mcp?version=2&format=json#section',
      'https://${MCP_HOST}/mcp?version=${MCP_VERSION}',
    ]) {
      expect(() => prepareCentralBundle(root, withUrl(url))).not.toThrow();
    }

    for (const url of [
      'https://user:password@example.test/mcp',
      'https://example.test/mcp?token=literal-secret',
      'https://example.test/mcp?version=2#session_id=literal-secret',
    ]) {
      expect(() => prepareCentralBundle(root, withUrl(url))).toThrow(/unsafe MCP URL|MCP URL credentials/i);
    }

    expect(() => prepareWorkflowExecutionBundle({
      rootWorkflow: withUrl('https://example.test/mcp?token=literal-secret'),
      workflowCallResolver: () => null,
      projectCwd: root,
      lookupCwd: root,
    })).not.toThrow();
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
    const partPersonaContent = 'part persona content';
    const config = workflow('root', [{
      name: 'implement',
      kind: 'agent',
      persona: 'leader step prompt',
      personaDisplayName: 'leader',
      instruction: '{task}',
      teamLeader: {
        persona: 'planning prompt',
        partPersona: partPersonaContent,
        maxConcurrency: 1,
        timeoutMs: 1_000,
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
    expect(readFileSync(partPersonaPath!, 'utf-8')).toBe(partPersonaContent);

    const partStep = createPartStep(loadedStep, {
      id: 'part-1',
      title: 'Part 1',
      instruction: 'Implement part 1',
    });
    expect(partStep.personaPath).toBe(partPersonaPath);
  });

  it('materializes and rebinds dynamic selector personas', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-selector-'));
    roots.push(root);
    const workflowDir = join(root, '.takt', 'workflows');
    const personasDir = join(root, '.takt', 'facets', 'personas');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(personasDir, { recursive: true });
    const facetSelectorPersonaPath = join(personasDir, 'facet-selector.md');
    const parallelSelectorPersonaPath = join(personasDir, 'reviewer-selector.md');
    writeFileSync(facetSelectorPersonaPath, 'Facet selector filesystem persona');
    writeFileSync(parallelSelectorPersonaPath, 'Parallel selector filesystem persona');

    const config = attachWorkflowOpaqueRef(normalizeWorkflowConfig({
      name: 'root',
      initial_step: 'implement',
      max_steps: 5,
      policies: { coding: 'Keep facet selection valid.' },
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
          instruction: '{task}',
          dynamic_facets: {
            pool: 'implementation-facets',
            selector: {
              persona: 'facet-selector',
              instruction: 'Select facets for the implementation.',
            },
          },
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
        {
          name: 'reviewers',
          instruction: '{task}',
          parallel: {
            pool: [{
              name: 'frontend',
              description: 'Frontend review',
              instruction: 'Review frontend changes',
              rules: [{ condition: 'approved', next: 'COMPLETE' }],
            }],
            selection: {
              mode: 'replace',
              selector: {
                persona: 'reviewer-selector',
                instruction: 'Select reviewers for the implementation.',
              },
            },
          },
          rules: [{ condition: 'all("approved")', next: 'COMPLETE' }],
        },
      ],
    }, workflowDir, { projectDir: root, workflowDir, lang: 'en' }), `project:sha256:${'r'.repeat(64)}`);

    const configuredFacetStep = config.steps[0] as Extract<WorkflowConfig['steps'][number], { dynamicFacets?: unknown }>;
    expect(configuredFacetStep.dynamicFacets?.selector?.personaPath).toBe(facetSelectorPersonaPath);
    const normalizedParallel = config.steps[1]?.parallel;
    if (normalizedParallel === undefined || Array.isArray(normalizedParallel)) {
      throw new Error('Expected a dynamic parallel step');
    }
    expect(normalizedParallel.selection.selector?.personaPath).toBe(parallelSelectorPersonaPath);

    const paths = buildRunPaths(root, 'selector-persona-run');
    publishWorkflowExecutionBundle(paths, prepareWorkflowExecutionBundle({
      rootWorkflow: config,
      workflowCallResolver: () => null,
      projectCwd: root,
      lookupCwd: root,
    }));

    const loaded = loadWorkflowExecutionBundle(paths);
    const loadedFacetStep = loaded.rootWorkflow.steps[0] as Extract<WorkflowConfig['steps'][number], { dynamicFacets?: unknown }>;
    const facetSelector = loadedFacetStep.dynamicFacets?.selector;
    const parallel = loaded.rootWorkflow.steps[1]?.parallel;
    if (parallel === undefined || Array.isArray(parallel)) {
      throw new Error('Expected a dynamic parallel step');
    }
    const parallelSelector = parallel.selection.selector;
    for (const [selector, expectedContent] of [
      [facetSelector, 'Facet selector filesystem persona'],
      [parallelSelector, 'Parallel selector filesystem persona'],
    ] as const) {
      const personaPath = selector?.personaPath;
      expect(personaPath).toBeDefined();
      expect(dirname(personaPath!)).toBe(loaded.resourceRoot);
      expect(basename(personaPath!)).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(personaPath!, 'utf-8')).toBe(expectedContent);
    }
  });

  it.each([
    ['dynamic facet selector for step "implement"', 'Facet selector filesystem persona', 'dynamicFacets'],
    ['dynamic parallel selector for step "reviewers"', 'Parallel selector filesystem persona', 'parallel'],
  ] as const)('rejects a bundle missing its %s resource', (label, removedContent, selectorKind) => {
    const root = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-selector-missing-'));
    roots.push(root);
    const workflowDir = join(root, '.takt', 'workflows');
    const personasDir = join(root, '.takt', 'facets', 'personas');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(personasDir, { recursive: true });
    writeFileSync(join(personasDir, 'facet-selector.md'), 'Facet selector filesystem persona');
    writeFileSync(join(personasDir, 'reviewer-selector.md'), 'Parallel selector filesystem persona');
    const config = normalizeWorkflowConfig({
      name: 'root',
      initial_step: 'implement',
      max_steps: 5,
      policies: { coding: 'Keep facet selection valid.' },
      facet_pools: {
        'implementation-facets': {
          candidates: [{ id: 'frontend', description: 'Frontend implementation', policy: 'coding' }],
        },
      },
      steps: [
        {
          name: 'implement',
          instruction: '{task}',
          dynamic_facets: {
            pool: 'implementation-facets',
            selector: { persona: 'facet-selector', instruction: 'Select facets for the implementation.' },
          },
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
        {
          name: 'reviewers',
          instruction: '{task}',
          parallel: {
            pool: [{ name: 'frontend', description: 'Frontend review', instruction: 'Review frontend changes', rules: [{ condition: 'approved', next: 'COMPLETE' }] }],
            selection: {
              mode: 'replace',
              selector: { persona: 'reviewer-selector', instruction: 'Select reviewers for the implementation.' },
            },
          },
          rules: [{ condition: 'all("approved")', next: 'COMPLETE' }],
        },
      ],
    }, workflowDir, { projectDir: root, workflowDir, lang: 'en' });
    const prepared = prepareWorkflowExecutionBundle({
      rootWorkflow: attachWorkflowOpaqueRef(config, `project:sha256:${'m'.repeat(64)}`),
      workflowCallResolver: () => null,
      projectCwd: root,
      lookupCwd: root,
    });

    const [, encoded] = [...prepared.objects.entries()][0]!;
    const node = JSON.parse(encoded) as {
      nodeId: string;
      originalWorkflowRef: string;
      binding: unknown;
      config: { steps: Array<Record<string, unknown>> };
    };
    const originalNodeId = node.nodeId;
    const facetSelector = (node.config.steps[0]!.dynamicFacets as { selector: Record<string, unknown> }).selector;
    const parallel = node.config.steps[1]!.parallel as { selection: { selector: Record<string, unknown> } };
    const removedSelector = selectorKind === 'dynamicFacets'
      ? facetSelector
      : parallel.selection.selector;
    delete removedSelector.personaPath;
    const removedHash = createHash('sha256').update(removedContent).digest('hex');
    const nodeId = createHash('sha256').update(canonicalJson({
      originalWorkflowRef: node.originalWorkflowRef,
      config: node.config,
      binding: node.binding,
    })).digest('hex');
    node.nodeId = nodeId;
    const nextEncoded = canonicalJson(node);
    const nextObjectHash = createHash('sha256').update(nextEncoded).digest('hex');
    const mutableManifest = prepared.manifest as unknown as {
      root: { nodeId: string };
      nodes: Record<string, string>;
      resources: Record<string, { kind: 'prompt' | 'arpeggio-source'; size: number }>;
    };
    mutableManifest.root.nodeId = nodeId;
    delete mutableManifest.nodes[originalNodeId];
    mutableManifest.nodes = { [nodeId]: nextObjectHash };
    delete mutableManifest.resources[removedHash];
    const mutableObjects = prepared.objects as unknown as Map<string, string>;
    mutableObjects.clear();
    mutableObjects.set(nextObjectHash, nextEncoded);
    (prepared.resources as unknown as Map<string, Buffer>).delete(removedHash);

    const paths = buildRunPaths(root, `missing-${selectorKind}`);
    publishWorkflowExecutionBundle(paths, prepared);
    expect(() => loadWorkflowExecutionBundle(paths)).toThrow(label);
  });

  it('attaches qualified participation identities for same-named static parallel sub-steps', () => {
    const project = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-parallel-project-'));
    const source = mkdtempSync(join(tmpdir(), 'takt-workflow-bundle-parallel-source-'));
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
      '    parallel:',
      '      - name: shared',
      '        persona: first shared prompt',
      '        instruction: "{task}"',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: second',
      '  - name: second',
      '    parallel:',
      '      - name: shared',
      '        persona: second shared prompt',
      '        instruction: "{task}"',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
      '  - name: shared',
      '    persona: top-level shared prompt',
      '    instruction: "{task}"',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
    ].join('\n'));
    const paths = buildRunPaths(project, 'parallel-run');
    mkdirSync(paths.runRootAbs, { recursive: true });
    const historicalRef = `project:sha256:${'d'.repeat(64)}`;
    const firstIdentity = buildWorkflowStepParticipationIdentity(historicalRef, 'shared', [], 'first');
    const secondIdentity = buildWorkflowStepParticipationIdentity(historicalRef, 'shared', [], 'second');
    const topLevelIdentity = buildWorkflowStepParticipationIdentity(historicalRef, 'shared', []);
    writeFileSync(paths.metaAbs, JSON.stringify({
      task: 'parallel legacy task',
      workflow: 'legacy',
      runSlug: 'parallel-run',
      runRoot: paths.runRootRel,
      reportDirectory: paths.reportsRel,
      contextDirectory: paths.contextRel,
      logsDirectory: paths.logsRel,
      status: 'failed',
      startTime: '2026-01-01T00:00:00.000Z',
      resume_point: {
        version: 2,
        stack: [{
          workflow: 'legacy', workflow_ref: historicalRef, step: 'first', kind: 'parallel', occurrence: 1,
        }],
        iteration: 1,
        elapsed_ms: 1,
        workflow_call_invocations: {},
        workflow_step_participations: {
          [firstIdentity]: { report_names: [] },
          [secondIdentity]: { report_names: [] },
          [topLevelIdentity]: { report_names: [] },
        },
      },
    }));

    const result = attachLegacyWorkflowExecutionBundle({
      projectDir: project,
      runSlug: 'parallel-run',
      sourceRoot: source,
      rootWorkflow: '.takt/workflows/legacy.yaml',
      dryRun: true,
    });

    expect(result.rootWorkflowRef).toBe(historicalRef);
    expect(result.published).toBe(false);
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
