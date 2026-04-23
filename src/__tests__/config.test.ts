/**
 * Tests for config functions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  getBuiltinWorkflow,
  loadAllWorkflows,
  loadWorkflow,
  listWorkflows,
  loadPersonaPromptFromPath,
  getProjectConfigDir,
  getBuiltinPersonasDir,
  getBuiltinWorkflowsDir,
  loadInputHistory,
  saveInputHistory,
  addToInputHistory,
  getInputHistoryPath,
  MAX_INPUT_HISTORY,
  // Persona session functions
  type PersonaSessionData,
  loadPersonaSessions,
  updatePersonaSession,
  getPersonaSessionsPath,
  // Worktree session functions
  getWorktreeSessionsDir,
  encodeWorktreePath,
  getWorktreeSessionPath,
  loadWorktreeSessions,
  updateWorktreeSession,
  getLanguage,
  loadProjectConfig,
  saveProjectConfig,
  isVerboseMode,
  resolveConfigValue,
  invalidateGlobalConfigCache,
  invalidateAllResolvedConfigCache,
} from '../infra/config/index.js';
import {
  getWorkflowPathTrustInfo,
  getWorkflowTrustInfo,
} from '../infra/config/loaders/workflowTrustSource.js';

let isolatedGlobalConfigDir: string;
let originalTaktConfigDirForFile: string | undefined;

beforeEach(() => {
  originalTaktConfigDirForFile = process.env.TAKT_CONFIG_DIR;
  isolatedGlobalConfigDir = join(tmpdir(), `takt-config-test-global-${randomUUID()}`);
  mkdirSync(isolatedGlobalConfigDir, { recursive: true });
  process.env.TAKT_CONFIG_DIR = isolatedGlobalConfigDir;
  writeFileSync(join(isolatedGlobalConfigDir, 'config.yaml'), 'language: en\n', 'utf-8');
  invalidateGlobalConfigCache();
});

afterEach(() => {
  if (originalTaktConfigDirForFile === undefined) {
    delete process.env.TAKT_CONFIG_DIR;
  } else {
    process.env.TAKT_CONFIG_DIR = originalTaktConfigDirForFile;
  }
  invalidateGlobalConfigCache();
  if (existsSync(isolatedGlobalConfigDir)) {
    rmSync(isolatedGlobalConfigDir, { recursive: true, force: true });
  }
});

describe('getBuiltinWorkflow', () => {
  it('should return builtin workflow when it exists in resources', () => {
    const workflow = getBuiltinWorkflow('default', process.cwd());
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('default');
  });

  it('should preserve builtin trust for privileged builtin workflows inside the repo tree', () => {
    const workflow = getBuiltinWorkflow('auto-improvement-loop', process.cwd());

    expect(workflow).not.toBeNull();
    expect(getWorkflowTrustInfo(workflow!, process.cwd())).toMatchObject({
      source: 'builtin',
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });
    expect(workflow!.steps.some((step) => step.kind === 'system')).toBe(true);
  });

  it('should resolve builtin instruction without projectCwd', () => {
    const workflow = getBuiltinWorkflow('default', process.cwd());
    expect(workflow).not.toBeNull();

    const planStep = workflow!.steps.find((step) => step.name === 'plan');
    expect(planStep).toBeDefined();
    expect(planStep!.instruction).not.toBe('plan');
  });

  it('should return null for non-existent workflow names', () => {
    expect(getBuiltinWorkflow('nonexistent-workflow', process.cwd())).toBeNull();
    expect(getBuiltinWorkflow('unknown', process.cwd())).toBeNull();
    expect(getBuiltinWorkflow('', process.cwd())).toBeNull();
  });

  it('should reject builtin workflow names that traverse outside the builtin directory', () => {
    const projectDir = join(tmpdir(), `takt-config-project-${randomUUID()}`);
    const maliciousWorkflowPath = join(projectDir, '.takt', 'workflows', 'evil.yaml');

    try {
      mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
      writeFileSync(maliciousWorkflowPath, `name: evil
max_steps: 10
initial_step: exploit
steps:
  - name: exploit
    kind: system
    command: echo exploit
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

      const traversalName = relative(
        getBuiltinWorkflowsDir('en'),
        maliciousWorkflowPath,
      ).replace(/\.ya?ml$/, '');

      expect(getBuiltinWorkflow(traversalName, projectDir)).toBeNull();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('should not treat non-language builtin subtrees as builtin trust roots', () => {
    const trustInfo = getWorkflowPathTrustInfo(
      join(process.cwd(), 'builtins', 'project', 'workflows', 'not-a-builtin.yaml'),
      process.cwd(),
    );

    expect(trustInfo.source).not.toBe('builtin');
  });
});

describe('default workflow parallel reviewers step', () => {
  it('should have a reviewers step with parallel sub-steps', () => {
    const workflow = getBuiltinWorkflow('default', process.cwd());
    expect(workflow).not.toBeNull();

    const reviewersStep = workflow!.steps.find((s) => s.name === 'reviewers');
    expect(reviewersStep).toBeDefined();
    expect(reviewersStep!.parallel).toBeDefined();
    expect(reviewersStep!.parallel).toHaveLength(2);
  });

  it('should have arch-review and supervise as parallel sub-steps', () => {
    const workflow = getBuiltinWorkflow('default', process.cwd());
    const reviewersStep = workflow!.steps.find((s) => s.name === 'reviewers')!;
    const subStepNames = reviewersStep.parallel!.map((s) => s.name);

    expect(subStepNames).toContain('arch-review');
    expect(subStepNames).toContain('supervise');
  });

  it('should have multi-condition aggregate rules on the reviewers parent step', () => {
    const workflow = getBuiltinWorkflow('default', process.cwd());
    const reviewersStep = workflow!.steps.find((s) => s.name === 'reviewers')!;

    expect(reviewersStep.rules).toBeDefined();
    expect(reviewersStep.rules).toHaveLength(2);

    const allRule = reviewersStep.rules!.find((r) => r.isAggregateCondition && r.aggregateType === 'all');
    expect(allRule).toBeDefined();
    // Multi-condition aggregate: first condition is always 'approved' (both en/ja)
    expect(Array.isArray(allRule!.aggregateConditionText)).toBe(true);
    expect((allRule!.aggregateConditionText as string[])[0]).toBe('approved');
    expect(allRule!.next).toBe('COMPLETE');

    const anyRule = reviewersStep.rules!.find((r) => r.isAggregateCondition && r.aggregateType === 'any');
    expect(anyRule).toBeDefined();
    // Multi-condition aggregate: first condition is always 'needs_fix' (both en/ja)
    expect(Array.isArray(anyRule!.aggregateConditionText)).toBe(true);
    expect((anyRule!.aggregateConditionText as string[])[0]).toBe('needs_fix');
    expect(anyRule!.next).toBe('fix');
  });

  it('should have arch-review sub-step with approved/needs_fix conditions', () => {
    const workflow = getBuiltinWorkflow('default', process.cwd());
    const reviewersStep = workflow!.steps.find((s) => s.name === 'reviewers')!;

    const archReview = reviewersStep.parallel!.find((s) => s.name === 'arch-review')!;
    expect(archReview.rules).toBeDefined();
    const conditions = archReview.rules!.map((r) => r.condition);
    expect(conditions).toContain('approved');
    expect(conditions).toContain('needs_fix');
  });

  it('should have supervise sub-step with 2 conditions', () => {
    const workflow = getBuiltinWorkflow('default', process.cwd());
    const reviewersStep = workflow!.steps.find((s) => s.name === 'reviewers')!;

    const supervise = reviewersStep.parallel!.find((s) => s.name === 'supervise')!;
    expect(supervise.rules).toBeDefined();
    expect(supervise.rules).toHaveLength(2);
  });

  it('should have ai_review transitioning to reviewers step', () => {
    const workflow = getBuiltinWorkflow('default', process.cwd());
    const aiReviewStep = workflow!.steps.find((s) => s.name === 'ai_review')!;

    const approveRule = aiReviewStep.rules!.find((r) => r.next === 'reviewers');
    expect(approveRule).toBeDefined();
  });

  it('should have ai_fix transitioning to ai_review step', () => {
    const workflow = getBuiltinWorkflow('default', process.cwd());
    const aiFixStep = workflow!.steps.find((s) => s.name === 'ai_fix')!;

    const fixedRule = aiFixStep.rules!.find((r) => r.next === 'ai_review');
    expect(fixedRule).toBeDefined();
  });

  it('should have fix step transitioning back to reviewers', () => {
    const workflow = getBuiltinWorkflow('default', process.cwd());
    const fixStep = workflow!.steps.find((s) => s.name === 'fix')!;

    const fixedRule = fixStep.rules!.find((r) => r.next === 'reviewers');
    expect(fixedRule).toBeDefined();
  });

  it('should not have old separate review/security_review/improve steps', () => {
    const workflow = getBuiltinWorkflow('default', process.cwd());
    const stepNames = workflow!.steps.map((s) => s.name);

    expect(stepNames).not.toContain('review');
    expect(stepNames).not.toContain('security_review');
    expect(stepNames).not.toContain('improve');
    expect(stepNames).not.toContain('security_fix');
  });

  it('should have sub-steps with correct agents', () => {
    const workflow = getBuiltinWorkflow('default', process.cwd());
    const reviewersStep = workflow!.steps.find((s) => s.name === 'reviewers')!;

    const archReview = reviewersStep.parallel!.find((s) => s.name === 'arch-review')!;
    expect(archReview.persona).toContain('architecture-reviewer');

    const supervise = reviewersStep.parallel!.find((s) => s.name === 'supervise')!;
    expect(supervise.persona).toContain('supervisor');
  });

  it('should have output contracts configured on sub-steps', () => {
    const workflow = getBuiltinWorkflow('default', process.cwd());
    const reviewersStep = workflow!.steps.find((s) => s.name === 'reviewers')!;

    const archReview = reviewersStep.parallel!.find((s) => s.name === 'arch-review')!;
    expect(archReview.outputContracts).toBeDefined();

    const supervise = reviewersStep.parallel!.find((s) => s.name === 'supervise')!;
    expect(supervise.outputContracts).toBeDefined();
  });
});

describe('loadAllWorkflows', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should load project-local workflows when cwd is provided', () => {
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    const sampleWorkflow = `
name: test-workflow
description: Test workflow
max_steps: 10
steps:
  - name: step1
    persona: coder
    instruction: "{task}"
    rules:
      - condition: Task completed
        next: COMPLETE
`;
    writeFileSync(join(workflowsDir, 'test.yaml'), sampleWorkflow);

    const workflows = loadAllWorkflows(testDir);

    expect(workflows.has('test')).toBe(true);
  });
});

describe('loadWorkflow (builtin fallback)', () => {
  it('should load builtin workflow when user workflow does not exist', () => {
    const workflow = loadWorkflow('default', process.cwd());
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('default');
  });

  it('should return null for non-existent workflow', () => {
    const workflow = loadWorkflow('does-not-exist', process.cwd());
    expect(workflow).toBeNull();
  });

  it('should load builtin workflows like default, research, audit-e2e', () => {
    const defaultWorkflow = loadWorkflow('default', process.cwd());
    expect(defaultWorkflow).not.toBeNull();
    expect(defaultWorkflow!.name).toBe('default');

    const research = loadWorkflow('research', process.cwd());
    expect(research).not.toBeNull();
    expect(research!.name).toBe('research');

    const auditE2e = loadWorkflow('audit-e2e', process.cwd());
    expect(auditE2e).not.toBeNull();
    expect(auditE2e!.name).toBe('audit-e2e');
  });
});

describe('loadWorkflow workflow_overrides.personas integration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(join(testDir, '.takt', 'workflows'), { recursive: true });
  });

  afterEach(() => {
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should apply persona quality gates from global then project configs', () => {
    writeFileSync(
      join(isolatedGlobalConfigDir, 'config.yaml'),
      [
        'language: en',
        'workflow_overrides:',
        '  personas:',
        '    coder:',
        '      quality_gates:',
        '        - "Global persona gate"',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(testDir, '.takt', 'config.yaml'),
      [
        'workflow_overrides:',
        '  personas:',
        '    coder:',
        '      quality_gates:',
        '        - "Project persona gate"',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(testDir, '.takt', 'workflows', 'persona-gates.yaml'),
      [
        'name: persona-gates',
        'description: Persona quality gates integration test',
        'max_steps: 3',
        'initial_step: implement',
        'steps:',
        '  - name: implement',
        '    persona: coder',
        '    edit: true',
        '    quality_gates:',
        '      - "YAML gate"',
        '    rules:',
        '      - condition: Done',
        '        next: COMPLETE',
        '    instruction: "{task}"',
      ].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const workflow = loadWorkflow('persona-gates', testDir);

    const step = workflow?.steps.find((currentStep) => currentStep.name === 'implement');
    expect(step?.qualityGates).toEqual([
      'Global persona gate',
      'Project persona gate',
      'YAML gate',
    ]);
  });

  it('should apply persona quality gates when step persona uses personas section alias key', () => {
    writeFileSync(
      join(isolatedGlobalConfigDir, 'config.yaml'),
      [
        'language: en',
        'workflow_overrides:',
        '  personas:',
        '    coder:',
        '      quality_gates:',
        '        - "Alias key gate"',
      ].join('\n'),
      'utf-8',
    );
    mkdirSync(join(testDir, '.takt', 'workflows', 'personas'), { recursive: true });
    writeFileSync(join(testDir, '.takt', 'workflows', 'personas', 'implementer.md'), 'Implementer persona', 'utf-8');
    writeFileSync(
      join(testDir, '.takt', 'workflows', 'persona-alias-key.yaml'),
      [
        'name: persona-alias-key',
        'description: personas alias key should drive override matching',
        'max_steps: 3',
        'initial_step: implement',
        'personas:',
        '  coder: ./personas/implementer.md',
        'steps:',
        '  - name: implement',
        '    persona: coder',
        '    quality_gates:',
        '      - "YAML gate"',
        '    rules:',
        '      - condition: Done',
        '        next: COMPLETE',
        '    instruction: "{task}"',
      ].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const workflow = loadWorkflow('persona-alias-key', testDir);

    const step = workflow?.steps.find((currentStep) => currentStep.name === 'implement');
    expect(step?.qualityGates).toEqual(['Alias key gate', 'YAML gate']);
  });

  it('should apply persona quality gates for path personas using basename key', () => {
    writeFileSync(
      join(isolatedGlobalConfigDir, 'config.yaml'),
      [
        'language: en',
        'workflow_overrides:',
        '  personas:',
        '    implementer:',
        '      quality_gates:',
        '        - "Path basename gate"',
      ].join('\n'),
      'utf-8',
    );
    mkdirSync(join(testDir, '.takt', 'workflows', 'personas'), { recursive: true });
    writeFileSync(join(testDir, '.takt', 'workflows', 'personas', 'implementer.md'), 'Implementer persona', 'utf-8');
    writeFileSync(
      join(testDir, '.takt', 'workflows', 'persona-path-key.yaml'),
      [
        'name: persona-path-key',
        'description: path personas should match overrides by basename',
        'max_steps: 3',
        'initial_step: implement',
        'steps:',
        '  - name: implement',
        '    persona: ./personas/implementer.md',
        '    quality_gates:',
        '      - "YAML gate"',
        '    rules:',
        '      - condition: Done',
        '        next: COMPLETE',
        '    instruction: "{task}"',
      ].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const workflow = loadWorkflow('persona-path-key', testDir);

    const step = workflow?.steps.find((currentStep) => currentStep.name === 'implement');
    expect(step?.qualityGates).toEqual(['Path basename gate', 'YAML gate']);
  });

  it('should not apply persona quality gates when persona does not match', () => {
    writeFileSync(
      join(isolatedGlobalConfigDir, 'config.yaml'),
      [
        'language: en',
        'workflow_overrides:',
        '  personas:',
        '    reviewer:',
        '      quality_gates:',
        '        - "Reviewer gate"',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(testDir, '.takt', 'workflows', 'persona-mismatch.yaml'),
      [
        'name: persona-mismatch',
        'description: Persona mismatch integration test',
        'max_steps: 3',
        'initial_step: implement',
        'steps:',
        '  - name: implement',
        '    persona: coder',
        '    quality_gates:',
        '      - "YAML gate"',
        '    rules:',
        '      - condition: Done',
        '        next: COMPLETE',
        '    instruction: "{task}"',
      ].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const workflow = loadWorkflow('persona-mismatch', testDir);

    const step = workflow?.steps.find((currentStep) => currentStep.name === 'implement');
    expect(step?.qualityGates).toEqual(['YAML gate']);
  });

  it('should not apply persona quality gates when step has no persona', () => {
    writeFileSync(
      join(isolatedGlobalConfigDir, 'config.yaml'),
      [
        'language: en',
        'workflow_overrides:',
        '  personas:',
        '    reviewer:',
        '      quality_gates:',
        '        - "Reviewer gate"',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(testDir, '.takt', 'workflows', 'no-persona-reviewer.yaml'),
      [
        'name: no-persona-reviewer',
        'description: No persona step should not match persona overrides',
        'max_steps: 3',
        'initial_step: reviewer',
        'steps:',
        '  - name: reviewer',
        '    quality_gates:',
        '      - "YAML gate"',
        '    rules:',
        '      - condition: Done',
        '        next: COMPLETE',
        '    instruction: "{task}"',
      ].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const workflow = loadWorkflow('no-persona-reviewer', testDir);

    const step = workflow?.steps.find((currentStep) => currentStep.name === 'reviewer');
    expect(step?.qualityGates).toEqual(['YAML gate']);
  });

  it('should not apply persona quality gates from persona_name without persona', () => {
    writeFileSync(
      join(isolatedGlobalConfigDir, 'config.yaml'),
      [
        'language: en',
        'workflow_overrides:',
        '  personas:',
        '    reviewer:',
        '      quality_gates:',
        '        - "Reviewer gate"',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(testDir, '.takt', 'workflows', 'persona-name-only.yaml'),
      [
        'name: persona-name-only',
        'description: persona_name should be display-only for persona overrides',
        'max_steps: 3',
        'initial_step: review',
        'steps:',
        '  - name: review',
        '    persona_name: reviewer',
        '    quality_gates:',
        '      - "YAML gate"',
        '    rules:',
        '      - condition: Done',
        '        next: COMPLETE',
        '    instruction: "{task}"',
      ].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const workflow = loadWorkflow('persona-name-only', testDir);

    const step = workflow?.steps.find((currentStep) => currentStep.name === 'review');
    expect(step?.qualityGates).toEqual(['YAML gate']);
  });

  it('should throw when step persona is an empty string', () => {
    writeFileSync(
      join(testDir, '.takt', 'workflows', 'empty-persona.yaml'),
      [
        'name: empty-persona',
        'description: Empty persona should fail fast',
        'max_steps: 3',
        'initial_step: implement',
        'steps:',
        '  - name: implement',
        '    persona: "   "',
        '    rules:',
        '      - condition: Done',
        '        next: COMPLETE',
        '    instruction: "{task}"',
      ].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    expect(() => loadWorkflow('empty-persona', testDir)).toThrow('Step "implement" has an empty persona value');
  });

  it('should throw when step persona_name is an empty string', () => {
    writeFileSync(
      join(testDir, '.takt', 'workflows', 'empty-persona-name.yaml'),
      [
        'name: empty-persona-name',
        'description: Empty persona_name should fail fast',
        'max_steps: 3',
        'initial_step: implement',
        'steps:',
        '  - name: implement',
        '    persona: coder',
        '    persona_name: "   "',
        '    rules:',
        '      - condition: Done',
        '        next: COMPLETE',
        '    instruction: "{task}"',
      ].join('\n'),
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    expect(() => loadWorkflow('empty-persona-name', testDir)).toThrow('Step "implement" has an empty persona_name value');
  });
});

describe('listWorkflows (builtin fallback)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should include builtin workflows', () => {
    const workflows = listWorkflows(testDir);
    expect(workflows).toContain('default');
    expect(workflows).toContain('audit-e2e');
  });

  it('should return sorted list', () => {
    const workflows = listWorkflows(testDir);
    const sorted = [...workflows].sort();
    expect(workflows).toEqual(sorted);
  });
});

describe('loadAllWorkflows (builtin fallback)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should include builtin workflows in the map', () => {
    const workflows = loadAllWorkflows(testDir);
    expect(workflows.has('default')).toBe(true);
  });
});

describe('loadPersonaPromptFromPath (builtin paths)', () => {
  it('should load persona prompt from builtin resources path', () => {
    const lang = getLanguage();
    const builtinPersonasDir = getBuiltinPersonasDir(lang);
    const personaPath = join(builtinPersonasDir, 'coder.md');

    if (existsSync(personaPath)) {
      const prompt = loadPersonaPromptFromPath(personaPath, process.cwd());
      expect(prompt).toBeTruthy();
      expect(typeof prompt).toBe('string');
    }
  });

  it('should reject persona prompt paths outside allowed roots', () => {
    expect(() => loadPersonaPromptFromPath('/tmp/not-allowed-persona.md', process.cwd())).toThrow(/not allowed/i);
  });
});

describe('loadProjectConfig provider_options', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should normalize provider_options into providerOptions (camelCase)', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'provider_options:',
      '  codex:',
      '    network_access: true',
      '  claude:',
      '    sandbox:',
      '      allow_unsandboxed_commands: true',
    ].join('\n'));

    const config = loadProjectConfig(testDir);

    expect(config.providerOptions).toEqual({
      codex: { networkAccess: true },
      claude: { sandbox: { allowUnsandboxedCommands: true } },
    });
  });

  it('should apply TAKT_PROVIDER_OPTIONS_* env overrides for project config', () => {
    const original = process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS;
    process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS = 'false';

    const config = loadProjectConfig(testDir);
    expect(config.providerOptions).toEqual({
      codex: { networkAccess: false },
    });

    if (original === undefined) {
      delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS;
    } else {
      process.env.TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS = original;
    }
  });

  it('should throw when provider block uses claude with network_access', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'provider:',
      '  type: claude',
      '  network_access: true',
    ].join('\n'));

    expect(() => loadProjectConfig(testDir)).toThrow(/network_access/);
  });

  it('should normalize project provider block into provider/model/providerOptions', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'provider:',
      '  type: codex',
      '  model: gpt-5.3',
      '  network_access: false',
    ].join('\n'));

    const config = loadProjectConfig(testDir);

    expect(config.provider).toBe('codex');
    expect(config.model).toBe('gpt-5.3');
    expect(config.providerOptions).toEqual({
      codex: { networkAccess: false },
    });
  });

  it('should allow claude sandbox in project provider block and normalize providerOptions', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'provider:',
      '  type: claude',
      '  model: sonnet',
      '  sandbox:',
      '    allow_unsandboxed_commands: true',
      '    excluded_commands:',
      '      - ./gradlew',
    ].join('\n'));

    const config = loadProjectConfig(testDir);

    expect(config.provider).toBe('claude');
    expect(config.model).toBe('sonnet');
    expect(config.providerOptions).toEqual({
      claude: {
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });

  it('should throw when provider block uses codex with sandbox', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'provider:',
      '  type: codex',
      '  sandbox:',
      '    allow_unsandboxed_commands: true',
    ].join('\n'));

    expect(() => loadProjectConfig(testDir)).toThrow(/sandbox/);
  });

  it('should throw when provider block contains unknown fields', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'provider:',
      '  type: codex',
      '  unknown_option: true',
    ].join('\n'));

    expect(() => loadProjectConfig(testDir)).toThrow(/Configuration error: invalid provider/);
  });

  it('should throw when project provider has unsupported type', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'provider: invalid-provider',
    ].join('\n'));

    expect(() => loadProjectConfig(testDir)).toThrow(/provider/);
  });
});

describe('analytics config resolution', () => {
  let testDir: string;
  let originalTaktConfigDir: string | undefined;
  let originalAnalyticsEnabled: string | undefined;
  let originalAnalyticsEventsPath: string | undefined;
  let originalAnalyticsRetentionDays: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    originalAnalyticsEnabled = process.env.TAKT_ANALYTICS_ENABLED;
    originalAnalyticsEventsPath = process.env.TAKT_ANALYTICS_EVENTS_PATH;
    originalAnalyticsRetentionDays = process.env.TAKT_ANALYTICS_RETENTION_DAYS;
    process.env.TAKT_CONFIG_DIR = join(testDir, 'global-takt');
    delete process.env.TAKT_ANALYTICS_ENABLED;
    delete process.env.TAKT_ANALYTICS_EVENTS_PATH;
    delete process.env.TAKT_ANALYTICS_RETENTION_DAYS;
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    if (originalAnalyticsEnabled === undefined) {
      delete process.env.TAKT_ANALYTICS_ENABLED;
    } else {
      process.env.TAKT_ANALYTICS_ENABLED = originalAnalyticsEnabled;
    }
    if (originalAnalyticsEventsPath === undefined) {
      delete process.env.TAKT_ANALYTICS_EVENTS_PATH;
    } else {
      process.env.TAKT_ANALYTICS_EVENTS_PATH = originalAnalyticsEventsPath;
    }
    if (originalAnalyticsRetentionDays === undefined) {
      delete process.env.TAKT_ANALYTICS_RETENTION_DAYS;
    } else {
      process.env.TAKT_ANALYTICS_RETENTION_DAYS = originalAnalyticsRetentionDays;
    }
    invalidateGlobalConfigCache();

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should normalize project analytics config from snake_case', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'analytics:',
      '  enabled: false',
      '  events_path: .takt/project-analytics/events',
      '  retention_days: 7',
    ].join('\n'));

    const config = loadProjectConfig(testDir);

    expect(config.analytics).toEqual({
      enabled: false,
      eventsPath: '.takt/project-analytics/events',
      retentionDays: 7,
    });
  });

  it('should apply TAKT_ANALYTICS_* env overrides for project config', () => {
    process.env.TAKT_ANALYTICS_ENABLED = 'true';
    process.env.TAKT_ANALYTICS_EVENTS_PATH = '/tmp/project-analytics';
    process.env.TAKT_ANALYTICS_RETENTION_DAYS = '5';

    const config = loadProjectConfig(testDir);
    expect(config.analytics).toEqual({
      enabled: true,
      eventsPath: '/tmp/project-analytics',
      retentionDays: 5,
    });
  });

  it('should merge analytics as project > global in resolveConfigValue', () => {
    const globalConfigDir = process.env.TAKT_CONFIG_DIR!;
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(join(globalConfigDir, 'config.yaml'), [
      'language: ja',
      'analytics:',
      '  enabled: true',
      '  events_path: /tmp/global-analytics',
      '  retention_days: 30',
    ].join('\n'));

    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'analytics:',
      '  events_path: /tmp/project-analytics',
      '  retention_days: 14',
    ].join('\n'));

    const analytics = resolveConfigValue(testDir, 'analytics');
    expect(analytics).toEqual({
      enabled: true,
      eventsPath: '/tmp/project-analytics',
      retentionDays: 14,
    });
  });

  it('should resolve language as project > global in resolveConfigValue', () => {
    const globalConfigDir = process.env.TAKT_CONFIG_DIR!;
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(join(globalConfigDir, 'config.yaml'), 'language: en\n');

    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), 'language: ja\n');

    expect(resolveConfigValue(testDir, 'language')).toBe('ja');
  });

  it('should expand "~/" in global analytics.events_path when resolved', () => {
    const globalConfigDir = process.env.TAKT_CONFIG_DIR!;
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(join(globalConfigDir, 'config.yaml'), [
      'language: ja',
      'analytics:',
      '  enabled: true',
      '  events_path: ~/.takt/global-analytics',
      '  retention_days: 30',
    ].join('\n'));

    const analytics = resolveConfigValue(testDir, 'analytics');

    expect(analytics).toEqual({
      enabled: true,
      eventsPath: join(homedir(), '.takt/global-analytics'),
      retentionDays: 30,
    });
  });

  it('should expand "~/" in project analytics.events_path and keep project precedence', () => {
    const globalConfigDir = process.env.TAKT_CONFIG_DIR!;
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(join(globalConfigDir, 'config.yaml'), [
      'language: ja',
      'analytics:',
      '  enabled: true',
      '  events_path: ~/.takt/global-analytics',
      '  retention_days: 30',
    ].join('\n'));

    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'analytics:',
      '  events_path: ~/.takt/project-analytics',
      '  retention_days: 14',
    ].join('\n'));

    const analytics = resolveConfigValue(testDir, 'analytics');

    expect(analytics).toEqual({
      enabled: true,
      eventsPath: join(homedir(), '.takt/project-analytics'),
      retentionDays: 14,
    });
  });
});

describe('isVerboseMode', () => {
  let testDir: string;
  let originalTaktConfigDir: string | undefined;
  let originalTaktLoggingDebug: string | undefined;
  let originalTaktLoggingTrace: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    originalTaktLoggingDebug = process.env.TAKT_LOGGING_DEBUG;
    originalTaktLoggingTrace = process.env.TAKT_LOGGING_TRACE;
    process.env.TAKT_CONFIG_DIR = join(testDir, 'global-takt');
    delete process.env.TAKT_LOGGING_DEBUG;
    delete process.env.TAKT_LOGGING_TRACE;
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    if (originalTaktLoggingDebug === undefined) {
      delete process.env.TAKT_LOGGING_DEBUG;
    } else {
      process.env.TAKT_LOGGING_DEBUG = originalTaktLoggingDebug;
    }
    if (originalTaktLoggingTrace === undefined) {
      delete process.env.TAKT_LOGGING_TRACE;
    } else {
      process.env.TAKT_LOGGING_TRACE = originalTaktLoggingTrace;
    }

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return false when neither project nor global logging.debug is set', () => {
    expect(isVerboseMode(testDir)).toBe(false);
  });

  it('should return true when global logging.debug is enabled', () => {
    const globalConfigDir = process.env.TAKT_CONFIG_DIR!;
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(
      join(globalConfigDir, 'config.yaml'),
      [
        'language: en',
        'logging:',
        '  debug: true',
      ].join('\n'),
      'utf-8',
    );

    expect(isVerboseMode(testDir)).toBe(true);
  });

  it('should return true when global logging.trace is enabled', () => {
    const globalConfigDir = process.env.TAKT_CONFIG_DIR!;
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(
      join(globalConfigDir, 'config.yaml'),
      [
        'language: en',
        'logging:',
        '  trace: true',
      ].join('\n'),
      'utf-8',
    );

    expect(isVerboseMode(testDir)).toBe(true);
  });

  it('should return true when TAKT_LOGGING_DEBUG=true is set', () => {
    process.env.TAKT_LOGGING_DEBUG = 'true';

    expect(isVerboseMode(testDir)).toBe(true);
  });

  it('should return true when TAKT_LOGGING_TRACE=true is set', () => {
    process.env.TAKT_LOGGING_TRACE = 'true';

    expect(isVerboseMode(testDir)).toBe(true);
  });

  it('should return true when global logging.level is debug', () => {
    const globalConfigDir = process.env.TAKT_CONFIG_DIR!;
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(
      join(globalConfigDir, 'config.yaml'),
      [
        'language: en',
        'logging:',
        '  level: debug',
      ].join('\n'),
      'utf-8',
    );

    expect(isVerboseMode(testDir)).toBe(true);
  });

  it('should return true when TAKT_LOGGING_DEBUG=true overrides config', () => {
    process.env.TAKT_LOGGING_DEBUG = 'true';
    expect(isVerboseMode(testDir)).toBe(true);
  });
});

describe('loadInputHistory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return empty array when no history exists', () => {
    const history = loadInputHistory(testDir);

    expect(history).toEqual([]);
  });

  it('should load saved history entries', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    const entries = ['"first entry"', '"second entry"'];
    writeFileSync(getInputHistoryPath(testDir), entries.join('\n'));

    const history = loadInputHistory(testDir);

    expect(history).toEqual(['first entry', 'second entry']);
  });

  it('should handle multi-line entries', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    const multiLine = 'line1\nline2\nline3';
    writeFileSync(getInputHistoryPath(testDir), JSON.stringify(multiLine));

    const history = loadInputHistory(testDir);

    expect(history).toHaveLength(1);
    expect(history[0]).toBe('line1\nline2\nline3');
  });
});

describe('saveInputHistory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should save history entries', () => {
    saveInputHistory(testDir, ['entry1', 'entry2']);

    const content = readFileSync(getInputHistoryPath(testDir), 'utf-8');
    expect(content).toBe('"entry1"\n"entry2"');
  });

  it('should create config directory if not exists', () => {
    const configDir = getProjectConfigDir(testDir);
    expect(existsSync(configDir)).toBe(false);

    saveInputHistory(testDir, ['test']);

    expect(existsSync(configDir)).toBe(true);
  });

  it('should preserve multi-line entries', () => {
    const multiLine = 'line1\nline2';
    saveInputHistory(testDir, [multiLine]);

    const history = loadInputHistory(testDir);

    expect(history[0]).toBe('line1\nline2');
  });
});

describe('addToInputHistory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should add new entry to history', () => {
    addToInputHistory(testDir, 'first');
    addToInputHistory(testDir, 'second');

    const history = loadInputHistory(testDir);

    expect(history).toEqual(['first', 'second']);
  });

  it('should not add consecutive duplicates', () => {
    addToInputHistory(testDir, 'same');
    addToInputHistory(testDir, 'same');

    const history = loadInputHistory(testDir);

    expect(history).toEqual(['same']);
  });

  it('should allow non-consecutive duplicates', () => {
    addToInputHistory(testDir, 'first');
    addToInputHistory(testDir, 'second');
    addToInputHistory(testDir, 'first');

    const history = loadInputHistory(testDir);

    expect(history).toEqual(['first', 'second', 'first']);
  });
});

describe('saveInputHistory - edge cases', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should trim history to MAX_INPUT_HISTORY entries', () => {
    const entries = Array.from({ length: 150 }, (_, i) => `entry${i}`);
    saveInputHistory(testDir, entries);

    const history = loadInputHistory(testDir);

    expect(history).toHaveLength(MAX_INPUT_HISTORY);
    // First 50 entries should be trimmed, keeping entries 50-149
    expect(history[0]).toBe('entry50');
    expect(history[MAX_INPUT_HISTORY - 1]).toBe('entry149');
  });

  it('should handle empty history array', () => {
    saveInputHistory(testDir, []);

    const history = loadInputHistory(testDir);

    expect(history).toEqual([]);
  });
});

describe('loadInputHistory - edge cases', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should skip invalid JSON entries', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    // Mix of valid JSON and invalid entries
    const content = '"valid entry"\ninvalid json\n"another valid"';
    writeFileSync(getInputHistoryPath(testDir), content);

    const history = loadInputHistory(testDir);

    // Invalid entries should be skipped
    expect(history).toEqual(['valid entry', 'another valid']);
  });

  it('should handle completely corrupted file', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    // All invalid JSON
    const content = 'not json\nalso not json\nstill not json';
    writeFileSync(getInputHistoryPath(testDir), content);

    const history = loadInputHistory(testDir);

    // All entries should be skipped
    expect(history).toEqual([]);
  });

  it('should handle file with only whitespace lines', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    const content = '   \n\n  \n';
    writeFileSync(getInputHistoryPath(testDir), content);

    const history = loadInputHistory(testDir);

    expect(history).toEqual([]);
  });
});

describe('saveProjectConfig - gitignore copy', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should copy .gitignore when creating new config', () => {
    saveProjectConfig(testDir, {});

    const configDir = getProjectConfigDir(testDir);
    const gitignorePath = join(configDir, '.gitignore');

    expect(existsSync(gitignorePath)).toBe(true);
  });

  it('should copy .gitignore to existing config directory without one', () => {
    // Create config directory without .gitignore
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), '');

    // Save config should still copy .gitignore
    saveProjectConfig(testDir, {});

    const gitignorePath = join(configDir, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
  });

  it('should not overwrite existing .gitignore', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    const customContent = '# Custom gitignore\nmy-custom-file';
    writeFileSync(join(configDir, '.gitignore'), customContent);

    saveProjectConfig(testDir, {});

    const gitignorePath = join(configDir, '.gitignore');
    const content = readFileSync(gitignorePath, 'utf-8');
    expect(content).toBe(customContent);
  });
});

// ============ Worktree Sessions ============

describe('encodeWorktreePath', () => {
  it('should replace slashes with dashes', () => {
    const encoded = encodeWorktreePath('/project/.takt/worktrees/my-task');

    expect(encoded).not.toContain('/');
    expect(encoded).toContain('-');
  });

  it('should handle Windows-style paths', () => {
    const encoded = encodeWorktreePath('C:\\project\\worktrees\\task');

    expect(encoded).not.toContain('\\');
    expect(encoded).not.toContain(':');
  });

  it('should produce consistent output for same input', () => {
    const path = '/project/.takt/worktrees/feature-x';
    const encoded1 = encodeWorktreePath(path);
    const encoded2 = encodeWorktreePath(path);

    expect(encoded1).toBe(encoded2);
  });
});

describe('getWorktreeSessionsDir', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return path inside .takt directory', () => {
    const sessionsDir = getWorktreeSessionsDir(testDir);

    expect(sessionsDir).toContain('.takt');
    expect(sessionsDir).toContain('worktree-sessions');
  });
});

describe('getWorktreeSessionPath', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return .json file path', () => {
    const sessionPath = getWorktreeSessionPath(testDir, '/worktree/path');

    expect(sessionPath).toMatch(/\.json$/);
  });

  it('should include encoded worktree path in filename', () => {
    const worktreePath = '/project/.takt/worktrees/my-feature';
    const sessionPath = getWorktreeSessionPath(testDir, worktreePath);

    expect(sessionPath).toContain('worktree-sessions');
  });
});

describe('loadWorktreeSessions', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return empty object when no session file exists', () => {
    const sessions = loadWorktreeSessions(testDir, '/some/worktree');

    expect(sessions).toEqual({});
  });

  it('should load saved sessions from file', () => {
    const worktreePath = '/project/worktree';
    const sessionsDir = getWorktreeSessionsDir(testDir);
    mkdirSync(sessionsDir, { recursive: true });

    const sessionPath = getWorktreeSessionPath(testDir, worktreePath);
    const data = {
      personaSessions: { coder: 'session-123', reviewer: 'session-456' },
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(sessionPath, JSON.stringify(data));

    const sessions = loadWorktreeSessions(testDir, worktreePath);

    expect(sessions).toEqual({ coder: 'session-123', reviewer: 'session-456' });
  });

  it('should return empty object for corrupted JSON', () => {
    const worktreePath = '/project/worktree';
    const sessionsDir = getWorktreeSessionsDir(testDir);
    mkdirSync(sessionsDir, { recursive: true });

    const sessionPath = getWorktreeSessionPath(testDir, worktreePath);
    writeFileSync(sessionPath, 'not valid json');

    const sessions = loadWorktreeSessions(testDir, worktreePath);

    expect(sessions).toEqual({});
  });
});

describe('updateWorktreeSession', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should create session file if not exists', () => {
    const worktreePath = '/project/worktree';

    updateWorktreeSession(testDir, worktreePath, 'coder', 'session-abc');

    const sessions = loadWorktreeSessions(testDir, worktreePath);
    expect(sessions).toEqual({ coder: 'session-abc' });
  });

  it('should update existing session', () => {
    const worktreePath = '/project/worktree';

    updateWorktreeSession(testDir, worktreePath, 'coder', 'session-1');
    updateWorktreeSession(testDir, worktreePath, 'coder', 'session-2');

    const sessions = loadWorktreeSessions(testDir, worktreePath);
    expect(sessions.coder).toBe('session-2');
  });

  it('should preserve other agent sessions when updating one', () => {
    const worktreePath = '/project/worktree';

    updateWorktreeSession(testDir, worktreePath, 'coder', 'coder-session');
    updateWorktreeSession(testDir, worktreePath, 'reviewer', 'reviewer-session');

    const sessions = loadWorktreeSessions(testDir, worktreePath);
    expect(sessions).toEqual({
      coder: 'coder-session',
      reviewer: 'reviewer-session',
    });
  });

  it('should create worktree-sessions directory if not exists', () => {
    const worktreePath = '/project/worktree';
    const sessionsDir = getWorktreeSessionsDir(testDir);
    expect(existsSync(sessionsDir)).toBe(false);

    updateWorktreeSession(testDir, worktreePath, 'coder', 'session-xyz');

    expect(existsSync(sessionsDir)).toBe(true);
  });

  it('should keep sessions isolated between different worktrees', () => {
    const worktree1 = '/project/worktree-1';
    const worktree2 = '/project/worktree-2';

    updateWorktreeSession(testDir, worktree1, 'coder', 'wt1-session');
    updateWorktreeSession(testDir, worktree2, 'coder', 'wt2-session');

    const sessions1 = loadWorktreeSessions(testDir, worktree1);
    const sessions2 = loadWorktreeSessions(testDir, worktree2);

    expect(sessions1.coder).toBe('wt1-session');
    expect(sessions2.coder).toBe('wt2-session');
  });
});

describe('provider-based session management', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('loadPersonaSessions with provider', () => {
    it('should return sessions when provider matches', () => {
      updatePersonaSession(testDir, 'coder', 'session-1', 'claude');

      const sessions = loadPersonaSessions(testDir, 'claude');
      expect(sessions.coder).toBe('session-1');
    });

    it('should return empty when provider has changed', () => {
      updatePersonaSession(testDir, 'coder', 'session-1', 'claude');

      const sessions = loadPersonaSessions(testDir, 'codex');
      expect(sessions).toEqual({});
    });

    it('should return sessions when no provider is specified (legacy)', () => {
      updatePersonaSession(testDir, 'coder', 'session-1');

      const sessions = loadPersonaSessions(testDir);
      expect(sessions.coder).toBe('session-1');
    });
  });

  describe('updatePersonaSession with provider', () => {
    it('should discard old sessions when provider changes', () => {
      updatePersonaSession(testDir, 'coder', 'claude-session', 'claude');
      updatePersonaSession(testDir, 'coder', 'codex-session', 'codex');

      const sessions = loadPersonaSessions(testDir, 'codex');
      expect(sessions.coder).toBe('codex-session');
      expect(sessions['coder:codex']).toBe('codex-session');
      // Old claude sessions should not remain
      expect(sessions['coder:claude']).toBeUndefined();
    });

    it('should store provider in session data', () => {
      updatePersonaSession(testDir, 'coder', 'session-1', 'claude');

      const path = getPersonaSessionsPath(testDir);
      const data = JSON.parse(readFileSync(path, 'utf-8')) as PersonaSessionData;
      expect(data.provider).toBe('claude');
    });
  });

  describe('loadWorktreeSessions with provider', () => {
    it('should return sessions when provider matches', () => {
      const worktreePath = '/project/worktree';
      updateWorktreeSession(testDir, worktreePath, 'coder', 'session-1', 'claude');

      const sessions = loadWorktreeSessions(testDir, worktreePath, 'claude');
      expect(sessions.coder).toBe('session-1');
    });

    it('should return empty when provider has changed', () => {
      const worktreePath = '/project/worktree';
      updateWorktreeSession(testDir, worktreePath, 'coder', 'session-1', 'claude');

      const sessions = loadWorktreeSessions(testDir, worktreePath, 'codex');
      expect(sessions).toEqual({});
    });
  });

  describe('updateWorktreeSession with provider', () => {
    it('should discard old sessions when provider changes', () => {
      const worktreePath = '/project/worktree';
      updateWorktreeSession(testDir, worktreePath, 'coder', 'claude-session', 'claude');
      updateWorktreeSession(testDir, worktreePath, 'coder', 'codex-session', 'codex');

      const sessions = loadWorktreeSessions(testDir, worktreePath, 'codex');
      expect(sessions.coder).toBe('codex-session');
      expect(sessions['coder:codex']).toBe('codex-session');
      expect(sessions['coder:claude']).toBeUndefined();
    });

    it('should store provider in session data', () => {
      const worktreePath = '/project/worktree';
      updateWorktreeSession(testDir, worktreePath, 'coder', 'session-1', 'claude');

      const sessionPath = getWorktreeSessionPath(testDir, worktreePath);
      const data = JSON.parse(readFileSync(sessionPath, 'utf-8')) as PersonaSessionData;
      expect(data.provider).toBe('claude');
    });
  });
});

describe('loadProjectConfig snake_case normalization', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should normalize auto_pr → autoPr and remove snake_case key', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), 'auto_pr: true\n');

    const config = loadProjectConfig(testDir);

    expect(config.autoPr).toBe(true);
    expect((config as Record<string, unknown>).auto_pr).toBeUndefined();
  });

  it('should normalize draft_pr → draftPr and remove snake_case key', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), 'draft_pr: true\n');

    const config = loadProjectConfig(testDir);

    expect(config.draftPr).toBe(true);
    expect((config as Record<string, unknown>).draft_pr).toBeUndefined();
  });

  it('should normalize base_branch → baseBranch and remove snake_case key', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), 'base_branch: main\n');

    const config = loadProjectConfig(testDir);

    expect(config.baseBranch).toBe('main');
    expect((config as Record<string, unknown>).base_branch).toBeUndefined();
  });
});

describe('loadProjectConfig submodules', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should normalize case-insensitive submodules all to canonical all', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), 'submodules: ALL\n');

    const config = loadProjectConfig(testDir);

    expect(config.submodules).toBe('all');
    expect(config.withSubmodules).toBeUndefined();
  });

  it('should keep explicit submodule path list as target set', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'submodules:',
      '  - path/a',
      '  - path/b',
    ].join('\n'));

    const config = loadProjectConfig(testDir);

    expect(config.submodules).toEqual(['path/a', 'path/b']);
    expect(config.withSubmodules).toBeUndefined();
  });

  it('should reject wildcard-only path in submodules', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'submodules:',
      '  - "*"',
    ].join('\n'));

    expect(() => loadProjectConfig(testDir)).toThrow('Invalid submodules');
  });

  it('should reject wildcard-like path in submodules', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'submodules:',
      '  - libs/*',
    ].join('\n'));

    expect(() => loadProjectConfig(testDir)).toThrow('Invalid submodules');
  });

  it('should prefer submodules over with_submodules', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'submodules:',
      '  - path/a',
      'with_submodules: true',
    ].join('\n'));

    const config = loadProjectConfig(testDir);

    expect(config.submodules).toEqual(['path/a']);
    expect(config.withSubmodules).toBeUndefined();
  });

  it('should treat with_submodules true as fallback full acquisition when submodules is unset', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), 'with_submodules: true\n');

    const config = loadProjectConfig(testDir);

    expect(config.submodules).toBeUndefined();
    expect(config.withSubmodules).toBe(true);
  });
});

describe('saveProjectConfig snake_case denormalization', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should persist autoPr as auto_pr and reload correctly', () => {
    saveProjectConfig(testDir, { autoPr: true });

    const saved = loadProjectConfig(testDir);

    expect(saved.autoPr).toBe(true);
    expect((saved as Record<string, unknown>).auto_pr).toBeUndefined();
  });

  it('should persist draftPr as draft_pr and reload correctly', () => {
    saveProjectConfig(testDir, { draftPr: true });

    const saved = loadProjectConfig(testDir);

    expect(saved.draftPr).toBe(true);
    expect((saved as Record<string, unknown>).draft_pr).toBeUndefined();
  });

  it('should persist baseBranch as base_branch and reload correctly', () => {
    saveProjectConfig(testDir, { baseBranch: 'main' });

    const saved = loadProjectConfig(testDir);

    expect(saved.baseBranch).toBe('main');
    expect((saved as Record<string, unknown>).base_branch).toBeUndefined();
  });

  it('should persist withSubmodules as with_submodules and reload correctly', () => {
    saveProjectConfig(testDir, { withSubmodules: true });

    const saved = loadProjectConfig(testDir);

    expect(saved.withSubmodules).toBe(true);
    expect((saved as Record<string, unknown>).with_submodules).toBeUndefined();
  });

  it('should persist submodules and ignore with_submodules when both are provided', () => {
    saveProjectConfig(testDir, { submodules: ['path/a'], withSubmodules: true });

    const projectConfigDir = getProjectConfigDir(testDir);
    const content = readFileSync(join(projectConfigDir, 'config.yaml'), 'utf-8');
    const saved = loadProjectConfig(testDir);

    expect(content).toContain('submodules:');
    expect(content).not.toContain('with_submodules:');
    expect(saved.submodules).toEqual(['path/a']);
    expect(saved.withSubmodules).toBeUndefined();
  });

  it('should persist concurrency and reload correctly', () => {
    saveProjectConfig(testDir, { concurrency: 3 });

    const saved = loadProjectConfig(testDir);

    expect(saved.concurrency).toBe(3);
  });

  it('should not write camelCase keys to YAML file', () => {
    saveProjectConfig(testDir, { autoPr: true, draftPr: false, baseBranch: 'develop' });

    const projectConfigDir = getProjectConfigDir(testDir);
    const content = readFileSync(join(projectConfigDir, 'config.yaml'), 'utf-8');

    expect(content).toContain('auto_pr:');
    expect(content).toContain('draft_pr:');
    expect(content).toContain('base_branch:');
    expect(content).not.toContain('withSubmodules:');
    expect(content).not.toContain('autoPr:');
    expect(content).not.toContain('draftPr:');
    expect(content).not.toContain('baseBranch:');
  });
});

describe('resolveConfigValue autoPr/draftPr/baseBranch/concurrency from project config', () => {
  let testDir: string;
  let originalTaktConfigDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = join(testDir, 'global-takt');
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    invalidateGlobalConfigCache();

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should resolve autoPr from project config written in snake_case YAML', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), 'auto_pr: true\n');

    expect(resolveConfigValue(testDir, 'autoPr')).toBe(true);
  });

  it('should resolve draftPr from project config written in snake_case YAML', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), 'draft_pr: true\n');

    expect(resolveConfigValue(testDir, 'draftPr')).toBe(true);
  });

  it('should resolve allowGitHooks and allowGitFilters from project config written in snake_case YAML', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), 'allow_git_hooks: true\nallow_git_filters: true\n');

    expect(resolveConfigValue(testDir, 'allowGitHooks')).toBe(true);
    expect(resolveConfigValue(testDir, 'allowGitFilters')).toBe(true);
  });

  it('should resolve baseBranch from project config written in snake_case YAML', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), 'base_branch: main\n');

    expect(resolveConfigValue(testDir, 'baseBranch')).toBe('main');
  });

  it('should resolve concurrency from project config', () => {
    const projectConfigDir = getProjectConfigDir(testDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), 'concurrency: 3\n');

    expect(resolveConfigValue(testDir, 'concurrency')).toBe(3);
  });
});
