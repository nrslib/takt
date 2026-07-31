import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import {
  captureConfigErrorMessage as thrownMessage,
  isolateStepFragmentTestConfig,
  writeStepFragmentTestFile as write,
} from './helpers/step-fragment-test-helpers.js';

describe('workflow step fragment normalizer provenance', () => {
  let projectDir: string;
  let restoreConfig: () => void;

  beforeEach(() => {
    restoreConfig = isolateStepFragmentTestConfig('takt-step-normalizer-provenance-config-');
    projectDir = mkdtempSync(join(tmpdir(), 'takt-step-normalizer-provenance-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    restoreConfig();
  });

  it('attributes an Arpeggio inline JavaScript policy error to the fragment that provides inline_js', () => {
    const innerPath = write(projectDir, '.takt/steps/inner.yaml', [
      'instruction: review',
      'arpeggio:',
      '  source: csv',
      '  source_path: input.csv',
      '  template: prompt.md',
      '  merge:',
      '    strategy: custom',
      '    inline_js: return items',
      '',
    ].join('\n'));
    write(projectDir, '.takt/steps/outer.yaml', 'uses: inner\narpeggio:\n  source: csv\n');
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: outer',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = thrownMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('step fragment "inner"');
    expect(message).toContain(innerPath);
    expect(message).not.toContain('step fragment "outer"');
  });

  it('attributes an Arpeggio source policy error to the fragment source field', () => {
    const fragmentPath = write(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'arpeggio:',
      '  source: custom-module',
      '  source_path: input.csv',
      '  template: prompt.md',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = thrownMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('uses Arpeggio source "custom-module"');
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('attributes an Arpeggio merge file policy error to the fragment merge file field', () => {
    const fragmentPath = write(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'arpeggio:',
      '  source: csv',
      '  source_path: input.csv',
      '  template: prompt.md',
      '  merge:',
      '    strategy: custom',
      '    file: merge.js',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = thrownMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('uses Arpeggio merge.file');
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('retains fragment context while identifying a caller-provided provider option reference error as workflow-defined', () => {
    write(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    provider_options:',
      '      extends: missing-options',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = thrownMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('provider_options.extends not found: missing-options');
    expect(message).toContain('step uses fragment "review"');
    expect(message).toContain('defined by the workflow');
  });

  it('attributes an empty fragment tag to the tag entry that defines it', () => {
    const fragmentPath = write(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'tags: ["   "]',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = thrownMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('empty tags entry');
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('attributes an implicit stdio MCP policy error to the fragment server object', () => {
    const fragmentPath = write(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'mcp_servers:',
      '  local:',
      '    command: local-mcp',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = thrownMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('uses MCP server "local" with transport "stdio"');
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('attributes an explicit MCP transport policy error to the fragment transport field', () => {
    const fragmentPath = write(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'mcp_servers:',
      '  remote:',
      '    type: sse',
      '    url: https://example.invalid/mcp',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = thrownMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('uses MCP server "remote" with transport "sse"');
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('attributes an invalid team leader inspect tool to the fragment entry', () => {
    const fragmentPath = write(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'team_leader:',
      '  inspect_tools: [bash]',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = thrownMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('team_leader.inspect_tools contains non-read-only tool "bash"');
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('attributes a Finding Contract output format error to the fragment format field', () => {
    const fragmentPath = write(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'output_contracts:',
      '  report:',
      '    - name: review.md',
      '      format: review-finding-contract',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = thrownMessage(() => new WorkflowEngine(
      loadWorkflowFromFile(workflowPath, projectDir),
      projectDir,
      'test task',
      {
        projectCwd: projectDir,
      },
    ));

    expect(message).toContain('has no finding_contract');
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });

  it('attributes an overridden team leader persona error to the outer fragment', () => {
    write(projectDir, '.takt/outside.md', 'outside persona\n');
    write(projectDir, '.takt/steps/inner.yaml', [
      'instruction: review',
      'team_leader:',
      '  persona: inner.md',
      '  part_tags: [review]',
      '',
    ].join('\n'));
    const outerPath = write(projectDir, '.takt/steps/outer.yaml', [
      'uses: inner',
      'team_leader:',
      '  persona: ../outside.md',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: outer',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = thrownMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('step fragment "outer"');
    expect(message).toContain(outerPath);
    expect(message).not.toContain('step fragment "inner"');
  });

  it('attributes overridden team leader part tags to the outer fragment', () => {
    write(projectDir, '.takt/steps/inner.yaml', [
      'instruction: review',
      'team_leader:',
      '  part_tags: [review]',
      '',
    ].join('\n'));
    const outerPath = write(projectDir, '.takt/steps/outer.yaml', [
      'uses: inner',
      'team_leader:',
      '  part_tags: ["   "]',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: outer',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = thrownMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('team_leader.part_tags contains an empty entry');
    expect(message).toContain('step fragment "outer"');
    expect(message).toContain(outerPath);
    expect(message).not.toContain('step fragment "inner"');
  });

  it('attributes an unresolved output contract order to the fragment order field', () => {
    write(projectDir, '.takt/facets/output-contracts/empty-order.md', '');
    const fragmentPath = write(projectDir, '.takt/steps/review.yaml', [
      'instruction: review',
      'output_contracts:',
      '  report:',
      '    - name: review.md',
      '      format: review format',
      '      order: ../facets/output-contracts/empty-order.md',
      '',
    ].join('\n'));
    const workflowPath = write(projectDir, '.takt/workflows/default.yaml', [
      'name: default',
      'initial_step: review',
      'max_steps: 1',
      'steps:',
      '  - name: review',
      '    uses: review',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'));

    const message = thrownMessage(() => loadWorkflowFromFile(workflowPath, projectDir));

    expect(message).toContain('Failed to resolve output contract order "../facets/output-contracts/empty-order.md"');
    expect(message).toContain('step fragment "review"');
    expect(message).toContain(fragmentPath);
  });
});
