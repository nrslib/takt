import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AutoRoutingConfig, WorkflowConfig } from '../core/models/index.js';
import {
  getWorkflowDescription,
  getWorkflowDescriptionFromConfig,
} from '../infra/config/loaders/workflowPreview.js';
import { withGlobalConfigDirOverride } from '../infra/config/paths.js';

describe('getWorkflowDescription', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function createProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'takt-workflow-preview-'));
    tempRoots.push(root);
    return root;
  }

  function createRuleBasedPreviewRouting(
    poolRules?: AutoRoutingConfig['poolRules'],
  ): AutoRoutingConfig {
    return {
      strategy: 'balanced',
      router: { provider: 'mock', model: 'gpt-router' },
      candidates: [{
        name: 'rule-candidate',
        description: 'Rule-based preview candidate',
        provider: 'codex',
        model: 'gpt-rule',
        routingTier: 'medium',
      }],
      candidatePools: {
        general: { candidates: ['rule-candidate'], fallback: 'rule-candidate' },
      },
      defaultPool: 'general',
      rules: { steps: { 'preview-auto-routing/implement': 'rule-candidate' } },
      ...(poolRules === undefined ? {} : { poolRules }),
    };
  }

  function createProgrammaticPreviewWorkflow(autoRouting: AutoRoutingConfig, model?: string): WorkflowConfig {
    return {
      name: 'preview-auto-routing',
      initialStep: 'implement',
      maxSteps: 1,
      ...(model === undefined ? {} : { model }),
      autoRouting,
      steps: [{
        name: 'implement',
        instruction: 'Implement the task',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    } as WorkflowConfig;
  }

  it('dynamic parallel の mode と fixed/pool role、static child facet を preview に含める (DFP-002, DFP-008)', () => {
    const projectDir = createProject();
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'provider: codex',
      'model: gpt-default',
      'takt_providers:',
      '  selector:',
      '    model: gpt-selector',
      '    provider_options:',
      '      codex:',
      '        reasoning_effort: medium',
    ].join('\n'));
    writeFileSync(join(workflowDir, 'dynamic-preview.yaml'), [
      'name: dynamic-preview',
      'initial_step: reviewers',
      'max_steps: 1',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      fixed:',
      '        - name: architecture',
      '          instruction: Review architecture',
      '          rules:',
      '            - condition: approved',
      '      pool:',
      '        - name: frontend',
      '          description: Review frontend',
      '          instruction: Review frontend',
      '          rules:',
      '            - condition: approved',
      '      selection:',
      '        mode: cumulative',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
    ].join('\n'));

    const description = getWorkflowDescription('dynamic-preview', projectDir, 1);

    expect(description.stepPreviews[0]).toMatchObject({
      name: 'reviewers',
      dynamicSelectionMode: 'cumulative',
      substeps: [
        {
          name: 'dynamic-selector',
          internalAgent: true,
          provider: 'codex',
          model: 'gpt-selector',
          providerSource: 'project',
          allowedTools: [],
          canEdit: false,
        },
        { name: 'architecture', parallelRole: 'fixed' },
        { name: 'frontend', parallelRole: 'pool' },
      ],
    });

    const overridden = getWorkflowDescription(
      'dynamic-preview',
      projectDir,
      1,
      projectDir,
      {
        provider: 'mock',
        model: 'cli-selector',
        providerSource: 'cli',
        modelSource: 'cli',
      },
    );
    expect(overridden.stepPreviews[0]?.substeps?.[0]).toMatchObject({
      name: 'dynamic-selector',
      provider: 'mock',
      model: 'cli-selector',
      providerSource: 'cli',
      modelSource: 'cli',
    });
    expect(description.stepPreviews[0]?.substeps?.[0]).not.toHaveProperty('providerOptions');
    expect(overridden.stepPreviews[0]?.substeps?.[0]).not.toHaveProperty('providerOptions');
    const facetDir = join(workflowDir, 'facets', 'policies');
    mkdirSync(facetDir, { recursive: true });
    writeFileSync(join(facetDir, 'review.md'), 'Review policy\n');
    writeFileSync(join(workflowDir, 'static-facet-preview.yaml'), [
      'name: static-facet-preview',
      'initial_step: reviewers',
      'max_steps: 1',
      'facet_pools:',
      '  security-facets:',
      '    policies:',
      '      review: ./facets/policies/review.md',
      '    candidates:',
      '      - id: web',
      '        description: Web security',
      '        policy: review',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      - name: security',
      '        persona: security-reviewer',
      '        instruction: Review security',
      '        dynamic_facets:',
      '          pool: security-facets',
      '          max_selected: 1',
      '        rules:',
      '          - condition: approved',
      '            next: COMPLETE',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
    ].join('\n'));

    const staticDescription = getWorkflowDescription('static-facet-preview', projectDir, 1);
    const security = staticDescription.stepPreviews[0]?.substeps?.find((step) => step.name === 'security');

    expect(security).toMatchObject({
      name: 'security',
      dynamicFacets: {
        pool: 'security-facets',
        maxSelected: 1,
        source: 'inline',
        candidates: [{
          id: 'web',
          description: 'Web security',
          policyRefs: ['review'],
          knowledgeRefs: [],
        }],
      },
    });
  });

  it('pool未割当のauto-routing step ruleはdefaults previewを上書きしない', () => {
    const projectDir = createProject();
    const globalConfigDir = createProject();
    const configDir = join(projectDir, '.takt');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'provider: mock\nmodel: gpt-default\n');
    const description = withGlobalConfigDirOverride(globalConfigDir, () => getWorkflowDescriptionFromConfig(
      createProgrammaticPreviewWorkflow(createRuleBasedPreviewRouting(), 'gpt-default'),
      projectDir,
      1,
    ));

    expect(description.stepPreviews[0]).toMatchObject({ model: 'gpt-default' });
    expect(description.stepPreviews[0]).toMatchObject({ provider: 'mock' });
  });

  it('明示的なpool割当があるauto-routing step ruleはrule-based previewを維持する', () => {
    const projectDir = createProject();
    const globalConfigDir = createProject();
    const description = withGlobalConfigDirOverride(globalConfigDir, () => getWorkflowDescriptionFromConfig(
      createProgrammaticPreviewWorkflow(
        createRuleBasedPreviewRouting({ steps: { 'preview-auto-routing/implement': 'general' } }),
      ),
      projectDir,
      1,
    ));

    expect(description.stepPreviews[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-rule',
    });
  });

  it('OpenCode selectorをshared transportでpreviewできる', () => {
    const projectDir = createProject();
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'takt_providers:',
      '  selector:',
      '    provider: opencode',
      '    model: opencode/big-pickle',
    ].join('\n'));
    writeFileSync(join(workflowDir, 'unsupported-selector-preview.yaml'), [
      'name: unsupported-selector-preview',
      'initial_step: reviewers',
      'max_steps: 1',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      pool:',
      '        - name: security',
      '          description: Review security',
      '          instruction: Review security',
      '          rules:',
      '            - condition: approved',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
    ].join('\n'));

    expect(getWorkflowDescription(
      'unsupported-selector-preview',
      projectDir,
      1,
    ).stepPreviews).toHaveLength(1);
  });

  it('AI向けselector previewへ実行用provider optionsを含めない', () => {
    const projectDir = createProject();
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'provider: codex',
      'model: gpt-default',
      'takt_providers:',
      '  selector:',
      '    model: gpt-selector',
      '    provider_options:',
      '      codex:',
      '        base_url: "http://selector-user:selector-password@127.0.0.1:8787?token=selector-token"',
      '        reasoning_effort: medium',
    ].join('\n'));
    writeFileSync(join(workflowDir, 'secret-preview.yaml'), [
      'name: secret-preview',
      'initial_step: reviewers',
      'max_steps: 1',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      pool:',
      '        - name: security',
      '          description: Review security',
      '          instruction: Review security',
      '          rules:',
      '            - condition: approved',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
    ].join('\n'));

    const description = getWorkflowDescription('secret-preview', projectDir, 1);
    const serializedPreview = JSON.stringify(description.stepPreviews);
    const selectorPreview = description.stepPreviews[0]?.substeps?.[0];

    expect(selectorPreview).toMatchObject({
      provider: 'codex',
      model: 'gpt-selector',
      providerSource: 'project',
    });
    expect(selectorPreview).not.toHaveProperty('providerOptions');
    expect(serializedPreview).not.toContain('selector-user');
    expect(serializedPreview).not.toContain('selector-password');
    expect(serializedPreview).not.toContain('selector-token');
    expect(serializedPreview).not.toContain('127.0.0.1:8787');
  });

  it('dynamic parallelを含まないworkflowでは未使用の不正selector設定を解決しない', () => {
    const projectDir = createProject();
    const workflowDir = join(projectDir, '.takt', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), [
      'takt_providers:',
      '  selector:',
      '    provider: opencode',
    ].join('\n'));
    writeFileSync(join(workflowDir, 'ordinary-preview.yaml'), [
      'name: ordinary-preview',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    instruction: Implement',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));

    expect(() => getWorkflowDescription('ordinary-preview', projectDir, 1)).not.toThrow();
  });

});
