import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { inspectWorkflowCommand } from '../features/workflowAuthoring/inspect.js';

const { outputEvents, mockBlankLine, mockError, mockHeader, mockInfo, mockSection, mockSuccess, mockWarn } = vi.hoisted(() => {
  const events: string[] = [];
  const createRecorder = (label: string) => vi.fn((...args: unknown[]) => {
    events.push(`${label}: ${args.map(String).join(' ')}`);
  });

  return {
    outputEvents: events,
    mockBlankLine: createRecorder('blank'),
    mockError: createRecorder('error'),
    mockHeader: createRecorder('header'),
    mockInfo: createRecorder('info'),
    mockSection: createRecorder('section'),
    mockSuccess: createRecorder('success'),
    mockWarn: createRecorder('warn'),
  };
});

vi.mock('../shared/ui/index.js', () => ({
  blankLine: (...args: unknown[]) => mockBlankLine(...args),
  error: (...args: unknown[]) => mockError(...args),
  header: (...args: unknown[]) => mockHeader(...args),
  info: (...args: unknown[]) => mockInfo(...args),
  section: (...args: unknown[]) => mockSection(...args),
  success: (...args: unknown[]) => mockSuccess(...args),
  warn: (...args: unknown[]) => mockWarn(...args),
}));

function writeFile(rootDir: string, relativePath: string, content: string): string {
  const filePath = join(rootDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function writeProjectFacet(projectDir: string, facetType: string, name: string, content = `${name} project facet`): string {
  return writeFile(projectDir, `.takt/facets/${facetType}/${name}.md`, content);
}

function writeGlobalFacet(globalDir: string, facetType: string, name: string, content = `${name} global facet`): string {
  return writeFile(globalDir, `facets/${facetType}/${name}.md`, content);
}

function renderedOutput(): string {
  return outputEvents.join('\n');
}

function expectField(output: string, field: string, value: string): void {
  const snakeCase = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldPattern = new RegExp(`^\\s*(?:${escapeRegExp(field)}|${escapeRegExp(snakeCase)}):`);
  const lines = output.split('\n');
  const start = lines.findIndex((line) => fieldPattern.test(lineContent(line)));
  expect(start).toBeGreaterThanOrEqual(0);
  if (start < 0) {
    return;
  }

  const startLine = lineContent(lines[start]!);
  const separator = startLine.indexOf(':');
  const inlineValue = startLine.slice(separator + 1).trim();
  if (inlineValue.length > 0) {
    expect(inlineValue.split(' (source:')[0]).toBe(value);
    return;
  }

  const startIndent = startLine.match(/^ */)?.[0].length ?? 0;
  const foundNestedValue = lines.slice(start + 1).some((line) => {
    const content = lineContent(line);
    if (content.trim().length === 0) {
      return false;
    }
    const indent = content.match(/^ */)?.[0].length ?? 0;
    if (indent <= startIndent) {
      return false;
    }
    const trimmed = content.trim().startsWith('- ')
      ? content.trim().slice(2).trim()
      : content.trim();
    const nestedSeparator = trimmed.lastIndexOf(':');
    const nestedValue = nestedSeparator < 0 ? trimmed : trimmed.slice(nestedSeparator + 1).trim();
    return nestedValue === value;
  });
  expect(foundNestedValue).toBe(true);
}

function lineContent(line: string): string {
  const separator = line.indexOf(': ');
  return separator < 0 ? line : line.slice(separator + 2);
}

function contentIndent(line: string): number {
  return lineContent(line).match(/^ */)?.[0].length ?? 0;
}

function stepBlock(output: string, stepName: string): string {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => lineContent(line).trim() === `- name: ${stepName}`);
  if (start < 0) {
    throw new Error(`step block not found: ${stepName}`);
  }
  const startIndentMatch = lineContent(lines[start]!).match(/^( *)- name:/);
  if (startIndentMatch === null) {
    throw new Error(`step block indentation not found: ${stepName}`);
  }
  const startIndent = startIndentMatch[1]!.length;
  const end = lines.findIndex((line, index) => (
    index > start
    && (
      lineContent(line).match(new RegExp(`^ {${startIndent}}- name:`)) !== null
      || (lineContent(line).match(/^ */)?.[0].length ?? 0) < startIndent
      || lineContent(line).trimStart().startsWith('Workflow inspect:')
    )
  ));
  return lines.slice(start, end < 0 ? lines.length : end).join('\n');
}

function workflowCallBlock(output: string, stepName: string): string {
  const block = stepBlock(output, stepName);
  const lines = block.split('\n');
  const nestedHeader = lines.findIndex((line) => lineContent(line).trimStart().startsWith('Workflow inspect:'));
  return lines.slice(0, nestedHeader < 0 ? lines.length : nestedHeader).join('\n');
}

function nestedSectionBlock(output: string, sectionName: string): string {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => lineContent(line).trim() === `${sectionName}:`);
  if (start < 0) {
    throw new Error(`section block not found: ${sectionName}`);
  }
  const startIndent = lineContent(lines[start]!).match(/^ */)?.[0].length ?? 0;
  const end = lines.findIndex((line, index) => {
    if (index <= start || lineContent(line).trim().length === 0) {
      return false;
    }
    return (lineContent(line).match(/^ */)?.[0].length ?? 0) <= startIndent;
  });
  return lines.slice(start, end < 0 ? lines.length : end).join('\n');
}

function facetBlocks(output: string, ref: string): string[] {
  const lines = output.split('\n');
  const starts = lines.flatMap((line, index) => {
    const content = lineContent(line).trim();
    return content === `- ref: ${ref}` || content === `persona: ${ref}` ? [index] : [];
  });
  if (starts.length === 0) {
    throw new Error(`facet block not found: ${ref}`);
  }
  return starts.map((start) => {
    const startIndentMatch = lineContent(lines[start]!).match(/^( *)(?:- ref:|persona:)/);
    if (startIndentMatch === null) {
      throw new Error(`facet block indentation not found: ${ref}`);
    }
    const startIndent = startIndentMatch[1]!.length;
    const end = lines.findIndex((line, index) => (
      index > start
      && lineContent(line).match(new RegExp(`^ {${startIndent}}(?:- ref:|[^ ]+:)`)) !== null
    ));
    return lines.slice(start, end < 0 ? lines.length : end).join('\n');
  });
}

function facetBlock(output: string, ref: string): string {
  return facetBlocks(output, ref)[0]!;
}

function expectResolvedLine(block: string, field: string, value: string, source: string): void {
  expect(block).toContain(`${field}: ${value} (source: ${source})`);
}

describe('workflow inspect', () => {
  let projectDir: string;
  let globalDir: string;
  let previousConfigDir: string | undefined;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-workflow-inspect-'));
    globalDir = mkdtempSync(join(tmpdir(), 'takt-workflow-inspect-global-'));
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalDir;
    writeFile(projectDir, '.takt/config.yaml', `language: en
provider: mock
model: config-model
workflow_command_gates:
  custom_scripts: true
workflow_mcp_servers:
  stdio: true
`);
    writeFile(projectDir, '.takt/schemas/rich-schema.json', '{}');
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    outputEvents.length = 0;
    mockBlankLine.mockClear();
    mockError.mockClear();
    mockHeader.mockClear();
    mockInfo.mockClear();
    mockSection.mockClear();
    mockSuccess.mockClear();
    mockWarn.mockClear();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      outputEvents.push(`console: ${args.map(String).join(' ')}`);
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('全ステップの設定と解決ソースを構造化テキストで表示する', async () => {
    writeProjectFacet(projectDir, 'personas', 'project-persona');
    writeProjectFacet(projectDir, 'instructions', 'project-instruction');
    writeProjectFacet(projectDir, 'instructions', 'retry-instruction');
    writeProjectFacet(projectDir, 'policies', 'project-policy');
    writeProjectFacet(projectDir, 'output-contracts', 'rich-format');
    writeGlobalFacet(globalDir, 'knowledge', 'global-knowledge');
    writeFile(projectDir, 'rows.csv', 'value\nitem\n');
    writeFile(projectDir, 'prompt.md', 'Process {line:1}\n');

    const workflowPath = writeFile(projectDir, '.takt/workflows/rich.yaml', `name: rich-inspect
initial_step: rich-agent
max_steps: 20
loop_monitors:
  - cycle: [rich-agent, system-step]
    threshold: 2
    judge:
      persona: coder
      instruction: inspect loop
      rules:
        - condition: healthy
          next: rich-agent
steps:
  - name: rich-agent
    description: rich-description
    session_key: rich-session
    session: compact
    requires_user_input: true
    persona: project-persona
    tags: [primary]
    instruction: project-instruction
    delay_before_ms: 12
    pass_previous_response: true
    allow_git_commit: true
    required_permission_mode: edit
    promotion:
      - at: 1
    edit: true
    mcp_servers:
      docs:
        type: stdio
        command: docs-mcp
        args: [serve]
    quality_gates:
      - type: command
        name: rich-gate
        command: ./check.sh
        cwd: .
        timeout_ms: 500
    structured_output:
      schema_ref: rich-schema
    output_contracts:
      report:
        - name: rich-report.md
          format: rich-format
    completion_retry:
      min_retry: 1
      max_retry: 2
      retry_instruction: retry-instruction
    policy: project-policy
    knowledge: global-knowledge
    rules:
      - condition: done
        next: dynamic-review
  - name: dynamic-review
    concurrency: 2
    parallel:
      fixed:
        - name: fixed-review
          persona: coder
          instruction: fixed review
          rules:
            - condition: approved
              next: COMPLETE
      pool:
        - name: pool-review
          description: pool-description
          persona: coder
          instruction: pool review
          rules:
            - condition: approved
              next: COMPLETE
      selection:
        mode: cumulative
        reports: [rich-report.md]
        selector:
          persona: coder
          instruction: selector guidance
    rules:
      - condition: all("approved")
        next: system-step
  - name: system-step
    mode: system
    system_inputs:
      - type: task_context
        source: current_task
        as: task
    effects:
      - type: comment_pr
        pr: 42
        body: System comment
    rules:
      - condition: done
        next: batch-step
  - name: batch-step
    instruction: batch instruction
    arpeggio:
      source: csv
      source_path: ../../rows.csv
      batch_size: 2
      concurrency: 1
      template: ../../prompt.md
      merge:
        strategy: concat
        separator: "\\n"
      max_retries: 1
      retry_delay_ms: 10
      output_path: ../../result.txt
    rules:
      - condition: done
        next: team-step
  - name: team-step
    instruction: delegate work
    team_leader:
      persona: coder
      max_parts: 2
      timeout_ms: 1000
      inspect_tools: [read]
      part_persona: coder
      part_tags: [part]
      part_allowed_tools: [read]
      part_edit: false
      part_permission_mode: edit
    rules:
      - condition: done
        next: builtin-step
  - name: builtin-step
    persona: coder
    instruction: Builtin step instruction
    policy: architecture
    knowledge: architecture
    rules:
      - condition: done
        next: fragment-step
  - name: fragment-step
    persona: coder
    instruction: Inline fragment instruction
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    expect(output).not.toMatch(/^\s*\{/m);
    expect(output).toContain('rich-inspect');
    for (const stepName of [
      'rich-agent',
      'dynamic-review',
      'fixed-review',
      'pool-review',
      'system-step',
      'batch-step',
      'team-step',
      'builtin-step',
      'fragment-step',
    ]) {
      expect(output).toContain(stepName);
    }

    const richAgentBlock = stepBlock(output, 'rich-agent');
    for (const [field, value] of [
      ['description', 'rich-description'],
      ['sessionKey', 'rich-session'],
      ['requiresUserInput', 'true'],
      ['session', 'compact'],
      ['tags', 'primary'],
      ['persona', 'project-persona'],
      ['instruction', 'project-instruction'],
      ['delayBeforeMs', '12'],
      ['passPreviousResponse', 'true'],
      ['allowGitCommit', 'true'],
      ['requiredPermissionMode', 'edit'],
      ['edit', 'true'],
      ['permissionMode', 'edit'],
      ['mcpServers', 'docs-mcp'],
      ['qualityGates', 'rich-gate'],
      ['structuredOutput', 'rich-schema'],
      ['outputContracts', 'rich-report.md'],
      ['format', 'rich-format'],
      ['minRetry', '1'],
      ['maxRetry', '2'],
      ['completionRetry', 'retry-instruction'],
      ['policy', 'project-policy'],
      ['knowledge', 'global-knowledge'],
      ['rules', 'dynamic-review'],
    ] as const) {
      expectField(richAgentBlock, field, value);
    }
    const qualityGateBlock = nestedSectionBlock(richAgentBlock, 'qualityGates');
    expectField(qualityGateBlock, 'type', 'command');
    expectField(qualityGateBlock, 'command', './check.sh');
    expectField(qualityGateBlock, 'cwd', '.');
    expectField(qualityGateBlock, 'timeoutMs', '500');
    const promotionBlock = nestedSectionBlock(richAgentBlock, 'promotion');
    expectField(promotionBlock, 'at', '1');
    expect(richAgentBlock).toContain('source: project');
    expect(richAgentBlock).toContain(join(projectDir, '.takt/facets/instructions/retry-instruction.md'));
    expectResolvedLine(richAgentBlock, 'provider', 'mock', 'project');
    expectResolvedLine(richAgentBlock, 'model', 'config-model', 'project');
    expectResolvedLine(richAgentBlock, 'permissionMode', 'edit', 'step');

    const dynamicReviewBlock = stepBlock(output, 'dynamic-review');
    for (const [field, value] of [
      ['parallel', 'cumulative'],
      ['concurrency', '2'],
      ['reports', 'rich-report.md'],
      ['selector', 'inline'],
    ] as const) {
      expectField(dynamicReviewBlock, field, value);
    }
    const fixedSectionBlock = nestedSectionBlock(dynamicReviewBlock, 'fixed');
    expect(fixedSectionBlock).toContain('- name: fixed-review');
    const fixedReviewBlock = stepBlock(fixedSectionBlock, 'fixed-review');
    for (const [field, value] of [
      ['persona', 'coder'],
      ['instruction', 'inline'],
      ['rules', 'approved'],
    ] as const) {
      expectField(fixedReviewBlock, field, value);
    }
    const poolSectionBlock = nestedSectionBlock(dynamicReviewBlock, 'pool');
    expect(poolSectionBlock).toContain('- name: pool-review');
    const poolReviewBlock = stepBlock(poolSectionBlock, 'pool-review');
    for (const [field, value] of [
      ['description', 'pool-description'],
      ['persona', 'coder'],
      ['instruction', 'inline'],
    ] as const) {
      expectField(poolReviewBlock, field, value);
    }
    const teamStepBlock = stepBlock(output, 'team-step');
    for (const [field, value] of [
      ['teamLeader', '2'],
      ['timeoutMs', '1000'],
      ['inspectTools', 'read'],
      ['partPersona', 'coder'],
      ['partTags', 'part'],
      ['partAllowedTools', 'read'],
      ['partEdit', 'false'],
      ['partPermissionMode', 'edit'],
    ] as const) {
      expectField(teamStepBlock, field, value);
    }
    const systemStepBlock = stepBlock(output, 'system-step');
    for (const [field, value] of [
      ['systemInputs', 'task_context'],
      ['source', 'current_task'],
      ['as', 'task'],
      ['effects', 'comment_pr'],
      ['pr', '42'],
      ['body', 'System comment'],
    ] as const) {
      expectField(systemStepBlock, field, value);
    }
    const batchStepBlock = stepBlock(output, 'batch-step');
    expectField(batchStepBlock, 'arpeggio', 'csv');
    const arpeggioBlock = nestedSectionBlock(batchStepBlock, 'arpeggio');
    for (const [field, value] of [
      ['source', 'csv'],
      ['sourcePath', join(projectDir, 'rows.csv')],
      ['batchSize', '2'],
      ['concurrency', '1'],
      ['templatePath', join(projectDir, 'prompt.md')],
      ['maxRetries', '1'],
      ['retryDelayMs', '10'],
      ['outputPath', join(projectDir, 'result.txt')],
    ] as const) {
      expectField(arpeggioBlock, field, value);
    }
    const loopMonitorBlock = output.slice(output.indexOf('loopMonitors:'));
    expectField(loopMonitorBlock, 'cycle', 'rich-agent');
    expectField(loopMonitorBlock, 'judge', 'inline');
    expect(dynamicReviewBlock).toContain('source: fragment');
    expect(fixedReviewBlock).toContain('source: fragment');
    expect(poolReviewBlock).toContain('source: fragment');
    expect(loopMonitorBlock).toContain('source: fragment');
    expect(loopMonitorBlock).not.toContain('inspect loop');
    expect(dynamicReviewBlock).not.toContain('selector guidance');
    expect(richAgentBlock).not.toContain('retry-instruction project facet');
    expect(output).not.toContain('fixed review');
    expect(output).not.toContain('pool review');
    expect(output).not.toContain('batch instruction');
    expect(output).not.toContain('delegate work');
    expect(output).not.toContain('Builtin step instruction');
    expect(output).not.toContain('Inline fragment instruction');
    expect(output).not.toContain('project persona facet');
    expect(output).not.toContain('global-knowledge global facet');
  });

  it('inline persona は各表示経路で本文ではなく参照情報を表示する', async () => {
    const workflowPath = writeFile(projectDir, '.takt/workflows/inline-personas.yaml', `name: inline-personas
initial_step: inline-step
max_steps: 3
facet_pools:
  review:
    candidates:
      - id: candidate
        description: candidate description
        policy: architecture
loop_monitors:
  - cycle: [inline-step, parallel-step]
    threshold: 1
    judge:
      persona: inline judge persona
      instruction: judge instruction
      rules:
        - condition: healthy
          next: inline-step
steps:
  - name: inline-step
    persona: inline step persona
    instruction: step instruction
    dynamic_facets:
      pool: review
      selector:
        persona: inline dynamic selector persona
        instruction: dynamic selector instruction
    rules:
      - condition: done
        next: parallel-step
  - name: parallel-step
    instruction: parallel instruction
    parallel:
      fixed: []
      pool:
        - name: pool-step
          description: pool description
          instruction: pool instruction
          rules:
            - condition: approved
              next: COMPLETE
      selection:
        mode: replace
        selector:
          persona: inline parallel selector persona
          instruction: parallel selector instruction
    rules:
      - condition: done
        next: team-step
  - name: team-step
    instruction: team instruction
    team_leader:
      persona: inline team leader persona
      max_parts: 2
      timeout_ms: 1000
      part_persona: inline part persona
      part_edit: false
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    for (const inlineContent of [
      'inline step persona',
      'inline dynamic selector persona',
      'inline parallel selector persona',
      'inline judge persona',
      'inline team leader persona',
      'inline part persona',
    ]) {
      expect(output).not.toContain(inlineContent);
    }
    const inlineStepBlock = stepBlock(output, 'inline-step');
    expect(inlineStepBlock).toContain('persona: inline');
    expect(inlineStepBlock).toContain('providerRoutingPersonaKey: inline');
    expect(inlineStepBlock).toContain('personaDisplayName: inline');
    expect(inlineStepBlock).toContain('source: fragment');
    const parallelStepBlock = stepBlock(output, 'parallel-step');
    expect(parallelStepBlock).toContain('persona: inline');
    expect(parallelStepBlock).toContain('source: fragment');
    const teamStepBlock = stepBlock(output, 'team-step');
    expect(teamStepBlock).toContain('persona: inline');
    expect(teamStepBlock).toContain('partPersona: inline');
    expect(teamStepBlock).toContain('personaDisplayName: inline');
    expect(teamStepBlock).toContain('providerRoutingPersonaKey: inline');
    expect(teamStepBlock).toContain('source: fragment');
    const loopMonitorBlock = output.slice(output.indexOf('loopMonitors:'));
    expect(loopMonitorBlock).toContain('persona: inline');
    expect(loopMonitorBlock).toContain('source: fragment');
  });

  it('required permission の昇格を step source として表示する', async () => {
    const workflowPath = writeFile(projectDir, '.takt/workflows/permission-source.yaml', `name: permission-source
initial_step: inspect
max_steps: 1
steps:
  - name: inspect
    instruction: inspect workflow
    required_permission_mode: edit
    rules:
      - condition: done
        next: COMPLETE
`);

    writeFile(projectDir, '.takt/config.yaml', `language: en
provider: mock
model: config-model
provider_profiles:
  mock:
    default_permission_mode: readonly
`);
    invalidateAllResolvedConfigCache();
    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();
    expect(renderedOutput()).toContain('permissionMode: edit (source: step)');

    outputEvents.length = 0;
    writeFile(projectDir, '.takt/config.yaml', `language: en
provider: mock
model: config-model
provider_profiles:
  mock:
    default_permission_mode: full
`);
    invalidateAllResolvedConfigCache();
    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();
    expect(renderedOutput()).toContain('permissionMode: full (source: project)');
  });

  it('persona の別名を全表示入口で解決先と分離して表示する', async () => {
    const personaPath = writeProjectFacet(projectDir, 'personas', 'lead', 'Lead persona body');
    const workflowPath = writeFile(projectDir, '.takt/workflows/persona-alias.yaml', `name: persona-alias
personas:
  lead: ../facets/personas/lead.md
initial_step: alias-step
max_steps: 3
facet_pools:
  review:
    candidates:
      - id: candidate
        description: candidate description
        policy: architecture
loop_monitors:
  - cycle: [alias-step, parallel-step]
    threshold: 1
    judge:
      persona: lead
      instruction: judge instruction
      rules:
        - condition: healthy
          next: alias-step
steps:
  - name: alias-step
    persona: lead
    instruction: step instruction
    dynamic_facets:
      pool: review
      selector:
        persona: lead
        instruction: dynamic selector instruction
    rules:
      - condition: done
        next: parallel-step
  - name: parallel-step
    instruction: parallel instruction
    parallel:
      fixed: []
      pool:
        - name: pool-step
          description: pool description
          instruction: pool instruction
          rules:
            - condition: approved
              next: COMPLETE
      selection:
        mode: replace
        selector:
          persona: lead
          instruction: parallel selector instruction
    rules:
      - condition: done
        next: team-step
  - name: team-step
    instruction: team instruction
    team_leader:
      persona: lead
      max_parts: 2
      timeout_ms: 1000
      part_persona: lead
      part_edit: false
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    const aliasStepBlock = stepBlock(output, 'alias-step');
    const parallelStepBlock = stepBlock(output, 'parallel-step');
    const teamStepBlock = stepBlock(output, 'team-step');
    for (const block of [aliasStepBlock, parallelStepBlock, teamStepBlock]) {
      expect(block).toContain('persona: lead');
      expect(block).toContain(personaPath);
      expect(block).toContain('source: project');
    }
    expect(teamStepBlock).toContain('partPersona: lead');
    expect(teamStepBlock).toContain(`path: ${personaPath}`);
    const loopMonitorBlock = output.slice(output.indexOf('loopMonitors:'));
    expect(loopMonitorBlock).toContain('persona: lead');
    expect(loopMonitorBlock).toContain(personaPath);
    expect(loopMonitorBlock).toContain('source: project');
    expect(output).not.toContain('Lead persona body');
  });

  it('別名経由の inline persona は別名を表示して本文を含めない', async () => {
    const personaBody = 'You are the lead reviewer';
    const workflowPath = writeFile(projectDir, '.takt/workflows/persona-inline-alias.yaml', `name: persona-inline-alias
personas:
  lead: "${personaBody}"
initial_step: inspect
max_steps: 1
steps:
  - name: inspect
    persona: lead
    instruction: inspect workflow
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    const inspectBlock = stepBlock(output, 'inspect');
    expect(inspectBlock).toContain('persona: lead');
    expect(inspectBlock).toContain('source: fragment');
    expect(inspectBlock).toContain('providerRoutingPersonaKey: inline');
    expect(output).not.toContain(personaBody);
  });

  it('名前と本文が一致する named facet を inline と誤表示しない', async () => {
    const workflowPath = writeFile(projectDir, '.takt/workflows/named-equal-content.yaml', `name: named-equal-content
policies:
  exact: exact
initial_step: inspect
max_steps: 1
facet_pools:
  review:
    candidates:
      - id: exact-candidate
        description: exact candidate
        policy: exact
steps:
  - name: inspect
    instruction: inspect workflow
    policy: exact
    dynamic_facets:
      pool: review
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    const inspectBlock = stepBlock(output, 'inspect');
    expectField(inspectBlock, 'policy', 'exact');
    expect(inspectBlock).toContain('source: fragment');
    expect(inspectBlock).not.toContain('policy: inline');
    const poolBlock = output.slice(output.indexOf('facetPools:'));
    const candidateBlock = nestedSectionBlock(poolBlock, 'candidates');
    expect(candidateBlock).toContain('- ref: exact');
    expect(candidateBlock).not.toContain('- ref: inline');
    expect(candidateBlock).toContain('source: fragment');
  });

  it('dynamic_facets 単独でも selector の値と解決ソースを表示する', async () => {
    const workflowPath = writeFile(projectDir, '.takt/workflows/dynamic-facets-selector.yaml', `name: dynamic-facets-selector
initial_step: select
max_steps: 1
facet_pools:
  review:
    candidates:
      - id: candidate
        description: candidate description
        policy: architecture
steps:
  - name: select
    instruction: select instruction
    dynamic_facets:
      pool: review
      selector:
        persona: coder
        instruction: selector instruction
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    expect(output).toContain('selectorProvider: mock (source: project)');
    expect(output).toContain('selectorModel: config-model (source: project)');
    expect(output).toContain('selectorPermission: readonly (source: synthetic)');
  });

  it('runtime-v1 の selector permission は explicit source で表示する', async () => {
    writeFile(projectDir, '.takt/config.yaml', 'language: en\n');
    writeFile(projectDir, '.takt/runtime.yaml', `version: 1
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: mock
      model: runtime-model
      permission_mode: edit
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/runtime-selector.yaml', `name: runtime-selector
initial_step: select
max_steps: 1
steps:
  - name: select
    instruction: select instruction
    parallel:
      pool:
        - name: candidate
          description: candidate description
          instruction: candidate instruction
          rules:
            - condition: approved
              next: COMPLETE
      selection:
        mode: replace
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    expect(output).toContain('selectorProvider: mock (source: runtime-v1)');
    expect(output).toContain('selectorModel: runtime-model (source: runtime-v1)');
    expect(output).toContain('selectorPermission: edit (source: explicit)');
  });

  it('selector 非該当の workflow では selector の解決値を表示しない', async () => {
    const workflowPath = writeFile(projectDir, '.takt/workflows/ordinary.yaml', `name: ordinary
initial_step: work
max_steps: 1
steps:
  - name: work
    instruction: work instruction
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    expect(output).not.toContain('selectorProvider:');
    expect(output).not.toContain('selectorModel:');
    expect(output).not.toContain('selectorPermission:');
  });

  it('facet の参照名、解決先パス、出所を表示する', async () => {
    const projectPersonaPath = writeProjectFacet(projectDir, 'personas', 'project-persona');
    const globalInstructionPath = writeGlobalFacet(globalDir, 'instructions', 'global-instruction');
    const builtinPolicyPath = join(process.cwd(), 'builtins/en/facets/policies/architecture.md');
    const builtinKnowledgePath = join(process.cwd(), 'builtins/en/facets/knowledge/architecture.md');
    const externalInstructionPath = writeFile(projectDir, 'docs/guide.md', 'external guide body');
    const workflowPath = writeFile(projectDir, '.takt/workflows/facets.yaml', `name: facet-sources
instructions:
  fragment-instruction: Inline fragment instruction
  guide: ../../docs/guide.md
  note: Inline section note
initial_step: sources
max_steps: 2
steps:
  - name: sources
    persona: project-persona
    instruction: global-instruction
    policy: architecture
    knowledge: architecture
    rules:
      - condition: done
        next: external
  - name: external
    instruction: guide
    rules:
      - condition: done
        next: inline
  - name: inline
    persona: coder
    instruction: fragment-instruction
    rules:
      - condition: done
        next: note
  - name: note
    instruction: note
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    const projectPersonaBlock = facetBlock(output, 'project-persona');
    expect(projectPersonaBlock).toContain(projectPersonaPath);
    expect(projectPersonaBlock).toContain('source: project');
    const globalInstructionBlock = facetBlock(output, 'global-instruction');
    expect(globalInstructionBlock).toContain(globalInstructionPath);
    expect(globalInstructionBlock).toContain('source: global');
    const architectureBlocks = facetBlocks(output, 'architecture');
    expect(architectureBlocks.length).toBeGreaterThanOrEqual(2);
    expect(architectureBlocks.some((block) => block.includes(builtinPolicyPath) && block.includes('source: builtin'))).toBe(true);
    expect(architectureBlocks.some((block) => block.includes(builtinKnowledgePath) && block.includes('source: builtin'))).toBe(true);
    const fragmentBlock = facetBlock(output, 'fragment-instruction');
    expect(fragmentBlock).toContain('source: fragment');
    const guideBlock = facetBlock(output, 'guide');
    expect(guideBlock).toContain(externalInstructionPath);
    expect(guideBlock).toContain('source: fragment');
    const noteBlock = facetBlock(output, 'note');
    expect(noteBlock).toContain('source: fragment');
    expect(noteBlock).not.toContain('Inline section note');
    expect(output).not.toContain('Inline fragment instruction');
    expect(output).not.toContain('external guide body');
  });

  it('inline policy/knowledge は step と facet pool の両方で本文を表示しない', async () => {
    const inlineStepPolicy = 'Keep the step policy private';
    const inlineStepKnowledge = 'Prefer existing step helpers';
    const inlinePoolPolicy = 'Always check pool invariants';
    const inlinePoolKnowledge = 'Use the pool evidence only';
    const workflowPath = writeFile(projectDir, '.takt/workflows/inline-facets.yaml', `name: inline-facets
initial_step: inspect
max_steps: 1
facet_pools:
  review:
    candidates:
      - id: inline-candidate
        description: inline candidate
        policy: "${inlinePoolPolicy}"
        knowledge: "${inlinePoolKnowledge}"
steps:
  - name: inspect
    instruction: inspect the workflow
    policy: "${inlineStepPolicy}"
    knowledge: "${inlineStepKnowledge}"
    dynamic_facets:
      pool: review
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    for (const inlineContent of [
      inlineStepPolicy,
      inlineStepKnowledge,
      inlinePoolPolicy,
      inlinePoolKnowledge,
    ]) {
      expect(output).not.toContain(inlineContent);
    }
    const step = stepBlock(output, 'inspect');
    expectField(step, 'policy', 'inline');
    expectField(step, 'knowledge', 'inline');
    expect(step).toContain('source: fragment');
    const pool = output.slice(output.indexOf('facetPools:'));
    expect(pool).toContain('inline-candidate');
    expectField(pool, 'policy', 'inline');
    expectField(pool, 'knowledge', 'inline');
    expect(pool).toContain('source: fragment');
  });

  it('output contract の inline order は本文を表示せず inline として表示する', async () => {
    const orderBody = 'Write the summary section first';
    writeProjectFacet(projectDir, 'output-contracts', 'simple-format');
    const workflowPath = writeFile(projectDir, '.takt/workflows/order-inline.yaml', `name: order-inline
initial_step: report-step
max_steps: 1
steps:
  - name: report-step
    instruction: report work
    output_contracts:
      report:
        - name: report.md
          format: simple-format
          order: "${orderBody}"
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const block = stepBlock(renderedOutput(), 'report-step');
    expect(block).toContain('order: inline');
    expect(block).toContain('orderSource: fragment');
    for (const line of outputEvents) {
      expect(line).not.toContain(orderBody);
    }
  });

  it('output contract の order 参照は参照名・出所・パスを表示し本文を表示しない', async () => {
    const orderBody = 'SECRET ORDER FACET BODY';
    const orderPath = writeProjectFacet(projectDir, 'output-contracts', 'order-facet', orderBody);
    writeProjectFacet(projectDir, 'output-contracts', 'simple-format');
    const workflowPath = writeFile(projectDir, '.takt/workflows/order-ref.yaml', `name: order-ref
initial_step: report-step
max_steps: 1
steps:
  - name: report-step
    instruction: report work
    output_contracts:
      report:
        - name: report.md
          format: simple-format
          order: order-facet
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const block = stepBlock(renderedOutput(), 'report-step');
    expect(block).toContain('order: order-facet');
    expect(block).toContain('orderSource: project');
    expect(block).toContain(`orderPath: ${orderPath}`);
    for (const line of outputEvents) {
      expect(line).not.toContain(orderBody);
    }
  });

  it('report_formats セクションの order キーはキー名と出所を表示し本文を表示しない', async () => {
    const orderBody = 'SECTION ORDER BODY MARKER';
    writeProjectFacet(projectDir, 'output-contracts', 'simple-format');
    const workflowPath = writeFile(projectDir, '.takt/workflows/order-section.yaml', `name: order-section
report_formats:
  myorder: "${orderBody}"
initial_step: report-step
max_steps: 1
steps:
  - name: report-step
    instruction: report work
    output_contracts:
      report:
        - name: report.md
          format: simple-format
          order: myorder
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const block = stepBlock(renderedOutput(), 'report-step');
    expect(block).toContain('order: myorder');
    expect(block).toContain('orderSource: fragment');
    for (const line of outputEvents) {
      expect(line).not.toContain(orderBody);
    }
  });

  it('単一トークンの order は本文を表示せず inline として表示する', async () => {
    writeProjectFacet(projectDir, 'output-contracts', 'simple-format');
    const workflowPath = writeFile(projectDir, '.takt/workflows/order-token.yaml', `name: order-token
initial_step: report-step
max_steps: 1
steps:
  - name: report-step
    instruction: report work
    output_contracts:
      report:
        - name: report.md
          format: simple-format
          order: SECRET_REPORT_ORDER_BODY
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const block = stepBlock(renderedOutput(), 'report-step');
    expect(block).toContain('order: inline');
    expect(block).toContain('orderSource: fragment');
    for (const line of outputEvents) {
      expect(line).not.toContain('SECRET_REPORT_ORDER_BODY');
    }
  });

  it('selector/judge/retry instruction は正規化した参照名と解決元を表示する', async () => {
    const judgeInstructionPath = writeProjectFacet(projectDir, 'instructions', 'judge-instruction', 'Judge the loop state');
    const retryInstructionPath = writeProjectFacet(projectDir, 'instructions', 'retry-instruction', 'Retry only the failed checks');
    const workflowPath = writeFile(projectDir, '.takt/workflows/specialized-instructions.yaml', `name: specialized-instructions
instructions:
  dynamic-selector: Select dynamic facets
  parallel-selector: Select parallel candidates
initial_step: dynamic-step
max_steps: 2
facet_pools:
  review:
    candidates:
      - id: candidate
        description: candidate
        policy: architecture
loop_monitors:
  - cycle: [dynamic-step, parallel-step]
    threshold: 1
    judge:
      persona: coder
      instruction: judge-instruction
      rules:
        - condition: healthy
          next: dynamic-step
steps:
  - name: dynamic-step
    instruction: dynamic step
    completion_retry:
      retry_instruction: retry-instruction
    dynamic_facets:
      pool: review
      selector:
        persona: coder
        instruction: dynamic-selector
    rules:
      - condition: done
        next: parallel-step
  - name: parallel-step
    instruction: parallel step
    parallel:
      fixed: []
      pool:
        - name: candidate
          description: candidate
          instruction: candidate work
          rules:
            - condition: approved
              next: COMPLETE
      selection:
        mode: replace
        selector:
          persona: coder
          instruction: parallel-selector
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    const dynamicStep = stepBlock(output, 'dynamic-step');
    expectField(dynamicStep, 'dynamicFacets', 'dynamic-selector');
    expect(dynamicStep).toContain('source: fragment');
    expectField(dynamicStep, 'completionRetry', 'retry-instruction');
    expect(dynamicStep).toContain(retryInstructionPath);
    const parallelStep = stepBlock(output, 'parallel-step');
    expectField(parallelStep, 'selector', 'parallel-selector');
    expect(parallelStep).toContain('source: fragment');
    const loopMonitor = output.slice(output.indexOf('loopMonitors:'));
    expectField(loopMonitor, 'judge', 'judge-instruction');
    expect(loopMonitor).toContain(judgeInstructionPath);
  });

  it('同一本文の複数 instruction ref では指定した retry ref を維持する', async () => {
    const workflowPath = writeFile(projectDir, '.takt/workflows/duplicate-instructions.yaml', `name: duplicate-instructions
instructions:
  retry-a: Same retry content
  retry-b: Same retry content
initial_step: retry-step
max_steps: 1
steps:
  - name: retry-step
    instruction: retry work
    completion_retry:
      retry_instruction: retry-b
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const step = stepBlock(renderedOutput(), 'retry-step');
    expectField(step, 'completionRetry', 'retry-b');
    expect(step).not.toContain('retryInstruction: retry-a');
    expect(renderedOutput()).not.toContain('Same retry content');
  });

  it('inline selector/judge/retry instruction は本文を表示せず inline として表示する', async () => {
    const selectorInstruction = 'Pick the safest candidate';
    const judgeInstruction = 'Judge only the reported loop state';
    const retryInstruction = 'Retry the failed completion checks';
    const workflowPath = writeFile(projectDir, '.takt/workflows/inline-specialized-instructions.yaml', `name: inline-specialized-instructions
initial_step: inspect
max_steps: 1
facet_pools:
  review:
    candidates:
      - id: candidate
        description: candidate
        policy: architecture
loop_monitors:
  - cycle: [inspect, marker]
    threshold: 1
    judge:
      instruction: "${judgeInstruction}"
      rules:
        - condition: healthy
          next: inspect
steps:
  - name: inspect
    instruction: inspect the workflow
    completion_retry:
      retry_instruction: "${retryInstruction}"
    dynamic_facets:
      pool: review
      selector:
        instruction: "${selectorInstruction}"
    rules:
      - condition: done
        next: marker
  - name: marker
    instruction: marker step
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    for (const inlineContent of [selectorInstruction, judgeInstruction, retryInstruction]) {
      expect(output).not.toContain(inlineContent);
    }
    const step = stepBlock(output, 'inspect');
    expectField(step, 'dynamicFacets', 'inline');
    expectField(step, 'completionRetry', 'inline');
    expect(step).toContain('source: fragment');
    const loopMonitor = output.slice(output.indexOf('loopMonitors:'));
    expectField(loopMonitor, 'judge', 'inline');
    expect(loopMonitor).toContain('source: fragment');
  });

  it('provider、model、permission の解決結果と解決ソースを CLI override と未指定の両方で表示する', async () => {
    writeFile(projectDir, '.takt/config.yaml', 'language: en\n');
    writeFile(projectDir, '.takt/runtime.yaml', `version: 1
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: mock
      model: runtime-model
      permission_mode: edit
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/providers.yaml', `name: provider-sources
initial_step: inspect
max_steps: 1
steps:
  - name: inspect
    persona: coder
    instruction: inspect providers
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();
    const configuredOutput = renderedOutput();
    const configuredStepBlock = stepBlock(configuredOutput, 'inspect');
    expectResolvedLine(configuredStepBlock, 'provider', 'mock', 'runtime-v1');
    expectResolvedLine(configuredStepBlock, 'model', 'runtime-model', 'runtime-v1');
    expectResolvedLine(configuredStepBlock, 'permissionMode', 'edit', 'runtime-v1');

    outputEvents.length = 0;
    mockInfo.mockClear();
    mockSuccess.mockClear();
    await expect(inspectWorkflowCommand(workflowPath, projectDir, {
      provider: 'codex',
      providerSource: 'cli',
      model: 'cli-model',
      modelSource: 'cli',
    })).resolves.toBeUndefined();
    const overriddenOutput = renderedOutput();
    const overriddenStepBlock = stepBlock(overriddenOutput, 'inspect');
    expectResolvedLine(overriddenStepBlock, 'provider', 'codex', 'cli');
    expectResolvedLine(overriddenStepBlock, 'model', 'cli-model', 'cli');
    expectResolvedLine(overriddenStepBlock, 'permissionMode', 'edit', 'default');
  });

  it('provider のみの CLI override 指定時は model が not configured、permissionMode が default ソースで表示される', async () => {
    writeFile(projectDir, '.takt/config.yaml', 'language: en\n');
    writeFile(projectDir, '.takt/runtime.yaml', `version: 1
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: mock
      model: runtime-model
      permission_mode: edit
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/provider-only-override.yaml', `name: provider-only-override
initial_step: inspect
max_steps: 1
steps:
  - name: inspect
    persona: coder
    instruction: inspect providers
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir, {
      provider: 'codex',
      providerSource: 'cli',
    })).resolves.toBeUndefined();

    const overriddenStepBlock = stepBlock(renderedOutput(), 'inspect');
    expectResolvedLine(overriddenStepBlock, 'provider', 'codex', 'cli');
    expectResolvedLine(overriddenStepBlock, 'model', 'not configured', 'cli');
    expectResolvedLine(overriddenStepBlock, 'permissionMode', 'edit', 'default');
  });

  it('model のみの CLI override 指定時は runtime の provider と permissionMode を保持して表示する', async () => {
    writeFile(projectDir, '.takt/config.yaml', 'language: en\n');
    writeFile(projectDir, '.takt/runtime.yaml', `version: 1
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: mock
      model: runtime-model
      permission_mode: edit
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/model-only-override.yaml', `name: model-only-override
initial_step: inspect
max_steps: 1
steps:
  - name: inspect
    persona: coder
    instruction: inspect providers
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir, {
      model: 'cli-model',
      modelSource: 'cli',
    })).resolves.toBeUndefined();

    const overriddenStepBlock = stepBlock(renderedOutput(), 'inspect');
    expectResolvedLine(overriddenStepBlock, 'provider', 'mock', 'runtime-v1');
    expectResolvedLine(overriddenStepBlock, 'model', 'cli-model', 'cli');
    expectResolvedLine(overriddenStepBlock, 'permissionMode', 'edit', 'runtime-v1');
  });

  it('team leader の実効 persona による provider、model、permission の解決結果を表示する', async () => {
    writeFile(projectDir, '.takt/config.yaml', 'language: en\n');
    writeProjectFacet(projectDir, 'personas', 'outer-coder');
    writeProjectFacet(projectDir, 'personas', 'leader-coder');
    writeFile(projectDir, '.takt/runtime.yaml', `version: 1
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: mock
      model: config-model
    outer:
      provider: mock
      model: outer-model
      permission_mode: edit
    leader:
      provider: codex
      model: leader-model
      permission_mode: readonly
  targets:
    personas:
      outer-coder:
        profile: outer
      leader-coder:
        profile: leader
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/team-leader-providers.yaml', `name: team-leader-providers
initial_step: team-step
max_steps: 1
steps:
  - name: team-step
    persona: outer-coder
    instruction: delegate work
    team_leader:
      persona: leader-coder
      max_parts: 1
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const teamStepBlock = stepBlock(renderedOutput(), 'team-step');
    expectResolvedLine(teamStepBlock, 'provider', 'codex', 'persona_providers');
    expectResolvedLine(teamStepBlock, 'model', 'leader-model', 'persona_providers');
    expectResolvedLine(teamStepBlock, 'permissionMode', 'readonly', 'persona_providers');
    expect(teamStepBlock).not.toContain('provider: mock (source: persona_providers)');
    expect(teamStepBlock).not.toContain('model: outer-model (source: persona_providers)');
    expect(teamStepBlock).not.toContain('permissionMode: edit (source: persona_providers)');

    outputEvents.length = 0;
    const inheritedWorkflowPath = writeFile(projectDir, '.takt/workflows/team-leader-inherited-provider.yaml', `name: team-leader-inherited-provider
initial_step: team-step
max_steps: 1
steps:
  - name: team-step
    persona: outer-coder
    instruction: delegate work
    team_leader:
      max_parts: 1
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(inheritedWorkflowPath, projectDir)).resolves.toBeUndefined();

    const inheritedTeamStepBlock = stepBlock(renderedOutput(), 'team-step');
    expectResolvedLine(inheritedTeamStepBlock, 'provider', 'mock', 'persona_providers');
    expectResolvedLine(inheritedTeamStepBlock, 'model', 'outer-model', 'persona_providers');
    expectResolvedLine(inheritedTeamStepBlock, 'permissionMode', 'edit', 'persona_providers');
  });

  it('persona_providers の provider、model、permission の解決結果と source を表示する', async () => {
    writeFile(projectDir, '.takt/config.yaml', 'language: en\n');
    writeFile(projectDir, '.takt/runtime.yaml', `version: 1
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: mock
      model: config-model
    persona:
      provider: codex
      model: persona-model
      permission_mode: readonly
  targets:
    personas:
      coder:
        profile: persona
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/persona-provider.yaml', `name: persona-provider
initial_step: inspect
max_steps: 1
steps:
  - name: inspect
    persona: coder
    instruction: inspect providers
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const inspectStepBlock = stepBlock(renderedOutput(), 'inspect');
    expectResolvedLine(inspectStepBlock, 'provider', 'codex', 'persona_providers');
    expectResolvedLine(inspectStepBlock, 'model', 'persona-model', 'persona_providers');
    expectResolvedLine(inspectStepBlock, 'permissionMode', 'readonly', 'persona_providers');
  });

  it('global config の provider、model、permission の解決結果と source を表示する', async () => {
    writeFile(projectDir, '.takt/config.yaml', 'language: en\n');
    writeFile(globalDir, 'config.yaml', `provider: mock
model: global-model
provider_profiles:
  mock:
    default_permission_mode: readonly
`);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    const workflowPath = writeFile(projectDir, '.takt/workflows/global-provider.yaml', `name: global-provider
initial_step: inspect
max_steps: 1
steps:
  - name: inspect
    instruction: inspect providers
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const inspectStepBlock = stepBlock(renderedOutput(), 'inspect');
    expectResolvedLine(inspectStepBlock, 'provider', 'mock', 'global');
    expectResolvedLine(inspectStepBlock, 'model', 'global-model', 'global');
    expectResolvedLine(inspectStepBlock, 'permissionMode', 'readonly', 'global');
  });

  it('workflow名付き provider_routing と auto rule の解決結果を値と source の組で表示する', async () => {
    writeFile(projectDir, '.takt/config.yaml', `language: en
provider: mock
model: default-model
provider_routing:
  steps:
    routing-inspect/qualified-step:
      provider: codex
      model: gpt-routed
`);
    invalidateAllResolvedConfigCache();
    const qualifiedPath = writeFile(projectDir, '.takt/workflows/routing-inspect.yaml', `name: routing-inspect
initial_step: qualified-step
max_steps: 1
steps:
  - name: qualified-step
    instruction: qualified routing
    rules:
      - condition: done
        next: COMPLETE
`);
    const otherPath = writeFile(projectDir, '.takt/workflows/other-flow.yaml', `name: other-flow
initial_step: qualified-step
max_steps: 1
steps:
  - name: qualified-step
    instruction: unqualified routing
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(qualifiedPath, projectDir)).resolves.toBeUndefined();
    const qualifiedBlock = stepBlock(renderedOutput(), 'qualified-step');
    expectResolvedLine(qualifiedBlock, 'provider', 'codex', 'provider_routing.steps');
    expectResolvedLine(qualifiedBlock, 'model', 'gpt-routed', 'provider_routing.steps');
    expectResolvedLine(qualifiedBlock, 'permissionMode', 'edit', 'default');

    outputEvents.length = 0;
    mockInfo.mockClear();
    mockSuccess.mockClear();
    await expect(inspectWorkflowCommand(otherPath, projectDir)).resolves.toBeUndefined();
    const unqualifiedBlock = stepBlock(renderedOutput(), 'qualified-step');
    expectResolvedLine(unqualifiedBlock, 'provider', 'mock', 'project');
    expectResolvedLine(unqualifiedBlock, 'model', 'default-model', 'project');
  });

  it('pool割当の auto rule で provider と model の source を表示する', async () => {
    writeFile(projectDir, '.takt/config.yaml', `language: en
provider: mock
model: default-model
auto_routing:
  strategy: balanced
  router:
    provider: mock
    model: router-model-1
  default_pool: general
  candidates:
    - name: coding
      description: coding tasks
      provider: codex
      model: gpt-5-auto
      routing_tier: medium
  rules:
    steps:
      auto-step: coding
  candidate_pools:
    general:
      candidates: [coding]
      fallback: coding
  pool_rules:
    steps:
      auto-step: general
`);
    invalidateAllResolvedConfigCache();
    const workflowPath = writeFile(projectDir, '.takt/workflows/auto.yaml', `name: auto-inspect
initial_step: auto-step
max_steps: 1
steps:
  - name: auto-step
    instruction: auto routing
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();
    const autoBlock = stepBlock(renderedOutput(), 'auto-step');
    expectResolvedLine(autoBlock, 'provider', 'codex', 'auto.rules');
    expectResolvedLine(autoBlock, 'model', 'gpt-5-auto', 'auto.rules');
    expectResolvedLine(autoBlock, 'permissionMode', 'edit', 'default');
  });

  it('pool割当で rule に一致しない場合は fallback candidate を auto.fallback で表示する', async () => {
    writeFile(projectDir, '.takt/config.yaml', `language: en
provider: mock
model: default-model
auto_routing:
  strategy: balanced
  router:
    provider: mock
    model: router-model-1
  default_pool: general
  candidates:
    - name: coding
      description: coding tasks
      provider: codex
      model: gpt-5-auto
      routing_tier: medium
  candidate_pools:
    general:
      candidates: [coding]
      fallback: coding
  pool_rules:
    steps:
      auto-step: general
`);
    invalidateAllResolvedConfigCache();
    const workflowPath = writeFile(projectDir, '.takt/workflows/auto-fallback.yaml', `name: auto-inspect-fallback
initial_step: auto-step
max_steps: 1
steps:
  - name: auto-step
    instruction: auto routing
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();
    const autoBlock = stepBlock(renderedOutput(), 'auto-step');
    expectResolvedLine(autoBlock, 'provider', 'codex', 'auto.fallback');
    expectResolvedLine(autoBlock, 'model', 'gpt-5-auto', 'auto.fallback');
    expectResolvedLine(autoBlock, 'permissionMode', 'edit', 'default');
    expect(autoBlock).not.toContain('not configured (source: unresolved)');
  });

  it('検証 error がある場合は診断を表示してカルテを表示せず非ゼロ終了する', async () => {
    const workflowPath = writeFile(projectDir, '.takt/workflows/invalid.yaml', `name: invalid-inspect
initial_step: broken
max_steps: 1
steps:
  - name: broken
    persona: missing-persona
    instruction: broken instruction
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).rejects.toThrow('Workflow validation failed');

    expect(mockError).toHaveBeenCalled();
    expect(mockSuccess).not.toHaveBeenCalled();
    expect(renderedOutput()).not.toContain('Workflow inspect: invalid-inspect');
  });

  it('warning のみの場合は警告をカルテ先頭に併記して exit 0 で表示する', async () => {
    const workflowPath = writeFile(projectDir, '.takt/workflows/warning.yaml', `name: cycle-warning-inspect
initial_step: warning-step
max_steps: 1
steps:
  - name: warning-step
    instruction: "use {report:ghost-report.md}"
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    const warningIndex = outputEvents.findIndex((event) => event.startsWith('warn:'));
    const cardIndex = outputEvents.findIndex((event) => event.startsWith('header: Workflow inspect:'));
    expect(mockWarn).toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
    expect(mockSuccess).toHaveBeenCalled();
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(cardIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeLessThan(cardIndex);
    expect(output).toContain('cycle-warning-inspect');
    expect(output).toContain('ghost-report.md');
  });

  it('workflow_call の子ワークフローを全段再帰展開する', async () => {
    writeFile(projectDir, '.takt/workflows/grandchild.yaml', `name: grandchild
subworkflow:
  callable: true
  returns: [done]
  params:
    child_policy:
      type: facet_ref
      facet_kind: policy
      default: architecture
initial_step: grandchild-step
max_steps: 1
steps:
  - name: grandchild-step
    instruction: grandchild work
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFile(projectDir, '.takt/workflows/child.yaml', `name: child
subworkflow:
  callable: true
  returns: [done]
  params:
    child:
      type: workflow_ref
      default: child
initial_step: child-call
max_steps: 1
steps:
  - name: child-call
    kind: workflow_call
    call: grandchild
    vars:
      child_label: child
    args:
      child_policy: architecture
    rules:
      - condition: done
        next: COMPLETE
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/root.yaml', `name: root
initial_step: root-call
max_steps: 1
steps:
  - name: root-call
    kind: workflow_call
    call: child
    vars:
      root_label: root
    args:
      child: child
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand('root', projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    const rootCallBlock = workflowCallBlock(output, 'root-call');
    expectField(rootCallBlock, 'call', 'child');
    const rootVarsBlock = nestedSectionBlock(rootCallBlock, 'vars');
    expectField(rootVarsBlock, 'root_label', 'root');
    const rootArgsBlock = nestedSectionBlock(rootCallBlock, 'args');
    expectField(rootArgsBlock, 'child', 'child');
    expect(rootCallBlock).not.toContain('child-call');
    const childCallBlock = workflowCallBlock(output, 'child-call');
    expectField(childCallBlock, 'call', 'grandchild');
    const childVarsBlock = nestedSectionBlock(childCallBlock, 'vars');
    expectField(childVarsBlock, 'child_label', 'child');
    const childArgsBlock = nestedSectionBlock(childCallBlock, 'args');
    expectField(childArgsBlock, 'child_policy', 'architecture');
    expect(childCallBlock).not.toContain('grandchild-step');
    expect(output).toContain('grandchild-step');
    expect(output.indexOf('child-call')).toBeGreaterThan(output.indexOf('root-call'));
    expect(output.indexOf('grandchild-step')).toBeGreaterThan(output.indexOf('child-call'));
    const rootCall = outputEvents.findIndex((event) => event.includes('- name: root-call'));
    const childHeader = outputEvents.findIndex((event) => event.includes('Workflow inspect: child'));
    const childStep = outputEvents.findIndex((event) => event.includes('- name: child-call'));
    const grandchildHeader = outputEvents.findIndex((event) => event.includes('Workflow inspect: grandchild'));
    const rootCallEvent = outputEvents[rootCall];
    const childHeaderEvent = outputEvents[childHeader];
    const childStepEvent = outputEvents[childStep];
    const grandchildHeaderEvent = outputEvents[grandchildHeader];
    expect(rootCall).toBeGreaterThanOrEqual(0);
    expect(childHeader).toBeGreaterThanOrEqual(0);
    expect(childStep).toBeGreaterThan(childHeader);
    expect(grandchildHeader).toBeGreaterThan(childStep);
    expect(contentIndent(childHeaderEvent!)).toBeGreaterThan(contentIndent(rootCallEvent!));
    expect(contentIndent(childStepEvent!)).toBeGreaterThan(contentIndent(childHeaderEvent!));
    expect(contentIndent(grandchildHeaderEvent!)).toBeGreaterThan(contentIndent(childHeaderEvent!));
  });

  it('child と grandchild の agent step の provider、model、permission を override 未指定時と provider のみの override 伝播時に表示する', async () => {
    writeFile(projectDir, '.takt/config.yaml', 'language: en\n');
    writeFile(projectDir, '.takt/runtime.yaml', `version: 1
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: mock
      model: runtime-model
      permission_mode: edit
`);
    invalidateAllResolvedConfigCache();
    writeFile(projectDir, '.takt/workflows/provider-grandchild.yaml', `name: provider-grandchild
subworkflow:
  callable: true
  returns: [done]
initial_step: grandchild-step
max_steps: 1
steps:
  - name: grandchild-step
    instruction: grandchild work
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFile(projectDir, '.takt/workflows/provider-child.yaml', `name: provider-child
subworkflow:
  callable: true
  returns: [done]
initial_step: child-step
max_steps: 2
steps:
  - name: child-step
    instruction: child work
    rules:
      - condition: done
        next: child-call
  - name: child-call
    kind: workflow_call
    call: provider-grandchild
    rules:
      - condition: done
        next: COMPLETE
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/provider-root.yaml', `name: provider-root
initial_step: root-call
max_steps: 1
steps:
  - name: root-call
    kind: workflow_call
    call: provider-child
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const configuredOutput = renderedOutput();
    for (const stepName of ['child-step', 'grandchild-step']) {
      const configuredStepBlock = stepBlock(configuredOutput, stepName);
      expectResolvedLine(configuredStepBlock, 'provider', 'mock', 'runtime-v1');
      expectResolvedLine(configuredStepBlock, 'model', 'runtime-model', 'runtime-v1');
      expectResolvedLine(configuredStepBlock, 'permissionMode', 'edit', 'runtime-v1');
    }

    outputEvents.length = 0;
    mockInfo.mockClear();
    mockSuccess.mockClear();
    await expect(inspectWorkflowCommand(workflowPath, projectDir, {
      provider: 'codex',
      providerSource: 'cli',
    })).resolves.toBeUndefined();

    const overriddenOutput = renderedOutput();
    for (const stepName of ['child-step', 'grandchild-step']) {
      const overriddenStepBlock = stepBlock(overriddenOutput, stepName);
      expectResolvedLine(overriddenStepBlock, 'provider', 'codex', 'cli');
      expectResolvedLine(overriddenStepBlock, 'model', 'not configured', 'cli');
      expectResolvedLine(overriddenStepBlock, 'permissionMode', 'edit', 'default');
    }
  });

  it('child workflow の provider 解決 error はカルテを出さず診断を表示して非ゼロ終了する', async () => {
    writeFile(projectDir, '.takt/config.yaml', 'language: en\n');
    writeFile(projectDir, '.takt/runtime.yaml', `version: 1
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: mock
      model: runtime-model
    alt:
      provider: mock
      model: alt-model
  targets:
    tags:
      t1:
        profile: default
      t2:
        profile: alt
`);
    invalidateAllResolvedConfigCache();
    writeFile(projectDir, '.takt/workflows/conflict-child.yaml', `name: conflict-child
subworkflow:
  callable: true
  returns: [done]
initial_step: child-step
max_steps: 1
steps:
  - name: child-step
    instruction: child work
    tags: [t1, t2]
    rules:
      - condition: done
        next: COMPLETE
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/conflict-root.yaml', `name: conflict-root
initial_step: root-call
max_steps: 1
steps:
  - name: root-call
    kind: workflow_call
    call: conflict-child
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).rejects.toThrow('Workflow validation failed');

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('conflict-child'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('child-step'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Conflicting provider routing for tags'));
    expect(renderedOutput()).not.toContain('Workflow inspect:');
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('grandchild workflow の provider 解決 error もカルテを出さず診断を表示して非ゼロ終了する', async () => {
    writeFile(projectDir, '.takt/config.yaml', 'language: en\n');
    writeFile(projectDir, '.takt/runtime.yaml', `version: 1
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: mock
      model: runtime-model
    alt:
      provider: mock
      model: alt-model
  targets:
    tags:
      t1:
        profile: default
      t2:
        profile: alt
`);
    invalidateAllResolvedConfigCache();
    writeFile(projectDir, '.takt/workflows/conflict-grandchild.yaml', `name: conflict-grandchild
subworkflow:
  callable: true
  returns: [done]
initial_step: grandchild-step
max_steps: 1
steps:
  - name: grandchild-step
    instruction: grandchild work
    tags: [t1, t2]
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFile(projectDir, '.takt/workflows/mid-child.yaml', `name: mid-child
subworkflow:
  callable: true
  returns: [done]
initial_step: mid-call
max_steps: 1
steps:
  - name: mid-call
    kind: workflow_call
    call: conflict-grandchild
    rules:
      - condition: done
        next: COMPLETE
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/grandchild-root.yaml', `name: grandchild-root
initial_step: root-call
max_steps: 1
steps:
  - name: root-call
    kind: workflow_call
    call: mid-child
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).rejects.toThrow('Workflow validation failed');

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('conflict-grandchild'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('grandchild-step'));
    expect(renderedOutput()).not.toContain('Workflow inspect:');
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('child workflow の parallel pool sub-step の provider 解決 error もカルテを出さず診断を表示して非ゼロ終了する', async () => {
    writeFile(projectDir, '.takt/config.yaml', 'language: en\n');
    writeFile(projectDir, '.takt/runtime.yaml', `version: 1
provider:
  defaults:
    profile: default
  profiles:
    default:
      provider: mock
      model: runtime-model
    alt:
      provider: mock
      model: alt-model
  targets:
    tags:
      t1:
        profile: default
      t2:
        profile: alt
`);
    invalidateAllResolvedConfigCache();
    writeFile(projectDir, '.takt/workflows/conflict-pool-child.yaml', `name: conflict-pool-child
subworkflow:
  callable: true
  returns: [done]
initial_step: child-parallel
max_steps: 1
steps:
  - name: child-parallel
    parallel:
      pool:
        - name: pool-conflict
          description: pool conflict
          instruction: pool work
          tags: [t1, t2]
          rules:
            - condition: approved
              next: COMPLETE
      selection:
        mode: replace
    rules:
      - condition: done
        next: COMPLETE
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/pool-root.yaml', `name: pool-root
initial_step: root-call
max_steps: 1
steps:
  - name: root-call
    kind: workflow_call
    call: conflict-pool-child
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).rejects.toThrow('Workflow validation failed');

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('conflict-pool-child'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('pool-conflict'));
    expect(renderedOutput()).not.toContain('Workflow inspect:');
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('static parallel substep の workflow_call を子カルテへ展開する', async () => {
    writeFile(projectDir, '.takt/workflows/parallel-child.yaml', `name: parallel-child
subworkflow:
  callable: true
  returns: [done]
initial_step: child-step
max_steps: 1
steps:
  - name: child-step
    instruction: child work
    rules:
      - condition: done
        next: COMPLETE
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/parallel-parent.yaml', `name: parallel-parent
initial_step: parent-step
max_steps: 1
steps:
  - name: parent-step
    parallel:
      - name: delegated-child
        kind: workflow_call
        call: parallel-child
        rules:
          - condition: done
            next: COMPLETE
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    expect(output).toContain('delegated-child');
    expect(output).toContain('Workflow inspect: parallel-child');
    expect(output).toContain('child-step');
    const parentStep = outputEvents.findIndex((event) => event.includes('- name: parent-step'));
    const delegatedStep = outputEvents.findIndex((event) => event.includes('- name: delegated-child'));
    const childHeader = outputEvents.findIndex((event) => event.includes('Workflow inspect: parallel-child'));
    const childStep = outputEvents.findIndex((event) => event.includes('- name: child-step'));
    expect(parentStep).toBeGreaterThanOrEqual(0);
    expect(delegatedStep).toBeGreaterThan(parentStep);
    expect(childHeader).toBeGreaterThan(delegatedStep);
    expect(childStep).toBeGreaterThan(childHeader);
  });

  it.each([
    { label: 'callable: false', subworkflow: 'subworkflow:\n  callable: false\n' },
    { label: 'callable 省略', subworkflow: '' },
  ])('非 callable child（$label）はカルテ表示前に診断して非ゼロ終了する', async ({ subworkflow }) => {
    writeFile(projectDir, '.takt/workflows/non-callable-target.yaml', `name: resolved-non-callable-child
${subworkflow}initial_step: child-step
max_steps: 1
steps:
  - name: child-step
    instruction: child work
    rules:
      - condition: done
        next: COMPLETE
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/non-callable-parent.yaml', `name: non-callable-parent
initial_step: parent-call
max_steps: 1
steps:
  - name: parent-call
    kind: workflow_call
    call: non-callable-target
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).rejects.toThrow('Workflow validation failed');

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('non-callable-parent'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('parent-call'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('non-callable-target'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('resolved-non-callable-child'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('is not callable'));
    expect(renderedOutput()).not.toContain('Workflow inspect:');
    expect(renderedOutput()).not.toContain('Workflow inspected:');
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('未知の named workflow_call target はカルテ表示前に診断して非ゼロ終了する', async () => {
    const workflowPath = writeFile(projectDir, '.takt/workflows/missing-named-parent.yaml', `name: missing-named-parent
initial_step: missing-call
max_steps: 1
steps:
  - name: missing-call
    kind: workflow_call
    call: missing-child
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).rejects.toThrow('Workflow validation failed');

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('missing-named-parent'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('missing-call'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('missing-child'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('workflow_call target was not found'));
    expect(renderedOutput()).not.toContain('Workflow inspect:');
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('static parallel 内の未知の path workflow_call target はカルテ表示前に診断して非ゼロ終了する', async () => {
    const workflowPath = writeFile(projectDir, '.takt/workflows/missing-parallel-parent.yaml', `name: missing-parallel-parent
initial_step: parent-step
max_steps: 1
steps:
  - name: parent-step
    parallel:
      - name: missing-path-call
        kind: workflow_call
        call: ./missing-child.yaml
        rules:
          - condition: done
            next: COMPLETE
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).rejects.toThrow('Workflow validation failed');

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('missing-parallel-parent'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('missing-path-call'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('./missing-child.yaml'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('workflow_call target was not found'));
    expect(renderedOutput()).not.toContain('Workflow inspect:');
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('nested child 内の未知の scope workflow_call target は親カルテ表示前に診断して非ゼロ終了する', async () => {
    writeFile(projectDir, '.takt/workflows/missing-scope-child.yaml', `name: missing-scope-child
subworkflow:
  callable: true
  returns: [done]
initial_step: missing-scope-call
max_steps: 1
steps:
  - name: missing-scope-call
    kind: workflow_call
    call: "@nrslib/takt-ensemble/no-such-workflow"
    rules:
      - condition: done
        next: COMPLETE
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/missing-scope-root.yaml', `name: missing-scope-root
initial_step: child-call
max_steps: 1
steps:
  - name: child-call
    kind: workflow_call
    call: missing-scope-child
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).rejects.toThrow('Workflow validation failed');

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('missing-scope-child'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('missing-scope-call'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('@nrslib/takt-ensemble/no-such-workflow'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('workflow_call target was not found'));
    expect(renderedOutput()).not.toContain('Workflow inspect:');
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('workflow_call target の解決例外は原因を診断してカルテ表示前に非ゼロ終了する', async () => {
    const workflowPath = writeFile(projectDir, '.takt/workflows/invalid-call-parent.yaml', `name: invalid-call-parent
initial_step: invalid-call
max_steps: 1
steps:
  - name: invalid-call
    kind: workflow_call
    call: missing//child
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).rejects.toThrow('Workflow validation failed');

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('invalid-call-parent'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('invalid-call'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('missing//child'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('cannot call invalid workflow identifier'));
    expect(renderedOutput()).not.toContain('Workflow inspect:');
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('循環する workflow_call を検出して再帰展開を打ち切る', async () => {
    writeFile(projectDir, '.takt/workflows/cycle-a.yaml', `name: cycle-a
subworkflow:
  callable: true
  returns: [done]
initial_step: call-b
max_steps: 1
steps:
  - name: call-b
    kind: workflow_call
    call: cycle-b
    rules:
      - condition: done
        next: COMPLETE
`);
    const workflowPath = writeFile(projectDir, '.takt/workflows/cycle-b.yaml', `name: cycle-b
subworkflow:
  callable: true
  returns: [done]
initial_step: call-a
max_steps: 1
steps:
  - name: call-a
    kind: workflow_call
    call: cycle-a
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).rejects.toThrow('Workflow validation failed');

    const output = renderedOutput();
    expect(output).toContain('recursive workflow_call cycle detected');
    expect(output).not.toContain('Workflow inspect: cycle-b');
    expect(output).not.toContain('Workflow inspected:');
    expect(mockError).toHaveBeenCalled();
  });

  it('必須引数を持つ callable workflow を discovery mode で表示する', async () => {
    const workflowPath = writeFile(projectDir, '.takt/workflows/required-callable.yaml', `name: required-callable
subworkflow:
  callable: true
  params:
    review_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
initial_step: review
max_steps: 1
steps:
  - name: review
    knowledge:
      $param: review_knowledge
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    expect(output).toContain('Workflow inspect: required-callable');
    expect(output).toContain('review');
    expect(mockError).not.toHaveBeenCalled();
  });

  it('非循環の workflow_call chain を深度上限で停止する', async () => {
    for (let index = 0; index <= 6; index += 1) {
      const stepName = `w${index}-step`;
      const content = index < 6
        ? `name: w${index}
subworkflow:
  callable: true
  returns: [done]
initial_step: ${stepName}
max_steps: 1
steps:
  - name: ${stepName}
    kind: workflow_call
    call: w${index + 1}
    rules:
      - condition: done
        next: COMPLETE
`
        : `name: w${index}
subworkflow:
  callable: true
  returns: [done]
initial_step: ${stepName}
max_steps: 1
steps:
  - name: ${stepName}
    instruction: final depth step
    rules:
      - condition: done
        next: COMPLETE
`;
      const dynamicMarker = index === 0
        ? `  - name: dynamic-marker
    parallel:
      pool:
        - name: marker-pool
          description: marker
          instruction: marker work
          rules:
            - condition: approved
              next: COMPLETE
      selection:
        mode: replace
    rules:
      - condition: done
        next: COMPLETE
`
        : '';
      const reachableContent = index === 0
        ? content.replace('        next: COMPLETE\n', '        next: dynamic-marker\n')
        : content;
      writeFile(projectDir, `.takt/workflows/w${index}.yaml`, `${reachableContent}${dynamicMarker}`);
    }

    const workflowPath = join(projectDir, '.takt/workflows/w0.yaml');
    await expect(inspectWorkflowCommand(workflowPath, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    expect(output).toContain('depth limit 5 reached');
    expect(output).toContain('w5-step');
    expect(output).not.toContain('w6-step');
    expect(output).not.toContain('circular reference detected');
  });

  it('ターゲット省略時は default ワークフローだけを解決する', async () => {
    writeFile(projectDir, '.takt/workflows/default.yaml', `name: default
initial_step: default-step
max_steps: 1
steps:
  - name: default-step
    instruction: default workflow
    rules:
      - condition: done
        next: COMPLETE
`);
    writeFile(projectDir, '.takt/workflows/other.yaml', `name: other
initial_step: other-step
max_steps: 1
steps:
  - name: other-step
    instruction: other workflow
    rules:
      - condition: done
        next: COMPLETE
`);

    await expect(inspectWorkflowCommand(undefined, projectDir)).resolves.toBeUndefined();

    const output = renderedOutput();
    expect(output).toContain('default-step');
    expect(output).not.toContain('other-step');
  });
});
