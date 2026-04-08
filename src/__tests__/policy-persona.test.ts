/**
 * Tests for policy and persona features.
 *
 * Covers:
 * - persona/persona_name fields in workflow YAML
 * - Workflow-level policies definition and resolution
 * - Step-level policy references
 * - Policy injection in InstructionBuilder
 * - File-based policy content loading via resolveContentPath
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import type { InstructionContext } from '../core/workflow/instruction/instruction-context.js';

// --- Test helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'takt-policy-'));
}

function makeContext(overrides: Partial<InstructionContext> = {}): InstructionContext {
  return {
    task: 'Test task',
    iteration: 1,
    maxSteps: 10,
    stepIteration: 1,
    cwd: '/tmp/test',
    projectCwd: '/tmp/test',
    userInputs: [],
    language: 'ja',
    ...overrides,
  };
}

// --- persona alias tests ---

describe('persona alias', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should treat persona as alias for agent', () => {
    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'step1',
          persona: 'inline-prompt-text',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.persona).toBe('inline-prompt-text');
  });

  it('should prefer persona over agent when both specified', () => {
    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'step1',
          persona: 'new-persona',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.persona).toBe('new-persona');
  });

  it('should have undefined persona when persona not specified', () => {
    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'step1',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.persona).toBeUndefined();
  });

  it('should treat persona_name as display name', () => {
    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'step1',
          persona: 'some-prompt',
          persona_name: 'My Persona',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.personaDisplayName).toBe('My Persona');
  });

  it('should use persona_name as display name', () => {
    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'step1',
          persona: 'some-persona',
          persona_name: 'New Name',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.personaDisplayName).toBe('New Name');
  });

  it('should resolve persona .md file path like agent', () => {
    const agentFile = join(testDir, 'my-persona.md');
    writeFileSync(agentFile, '# Test Persona\nYou are a test persona.');

    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'step1',
          persona: './my-persona.md',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.persona).toBe('./my-persona.md');
    expect(config.steps[0]!.personaPath).toBe(agentFile);
  });

  it('should work with persona in parallel sub-steps', () => {
    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'parallel-step',
          parallel: [
            {
              name: 'sub1',
              persona: 'sub-persona-1',
              instruction: '{task}',
            },
            {
              name: 'sub2',
              persona: 'sub-persona-2',
              persona_name: 'Sub Persona 2',
              instruction: '{task}',
            },
          ],
          rules: [{ condition: 'all("done")', next: 'COMPLETE' }],
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    const parallel = config.steps[0]!.parallel!;
    expect(parallel[0]!.persona).toBe('sub-persona-1');
    expect(parallel[1]!.persona).toBe('sub-persona-2');
    expect(parallel[1]!.personaDisplayName).toBe('Sub Persona 2');
  });
});

// --- policy tests ---

describe('policies', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should resolve workflow-level policies from inline content', () => {
    const raw = {
      name: 'test-workflow',
      policies: {
        coding: 'Always write clean code.',
        review: 'Be thorough in reviews.',
      },
      steps: [
        {
          name: 'step1',
          persona: 'coder',
          policy: 'coding',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.policies).toEqual({
      coding: 'Always write clean code.',
      review: 'Be thorough in reviews.',
    });
    expect(config.steps[0]!.policyContents).toEqual(['Always write clean code.']);
  });

  it('should resolve policies from .md file paths', () => {
    const policiesDir = join(testDir, 'policies');
    mkdirSync(policiesDir, { recursive: true });
    writeFileSync(join(policiesDir, 'coding.md'), '# Coding Policy\n\nWrite clean code.');
    writeFileSync(join(policiesDir, 'review.md'), '# Review Policy\n\nBe thorough.');

    const raw = {
      name: 'test-workflow',
      policies: {
        coding: './policies/coding.md',
        review: './policies/review.md',
      },
      steps: [
        {
          name: 'step1',
          persona: 'coder',
          policy: 'coding',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.policies!['coding']).toBe('# Coding Policy\n\nWrite clean code.');
    expect(config.policies!['review']).toBe('# Review Policy\n\nBe thorough.');
    expect(config.steps[0]!.policyContents).toEqual(['# Coding Policy\n\nWrite clean code.']);
  });

  it('should support multiple policy references (array)', () => {
    const raw = {
      name: 'test-workflow',
      policies: {
        coding: 'Clean code rules.',
        testing: 'Test everything.',
      },
      steps: [
        {
          name: 'step1',
          persona: 'coder',
          policy: ['coding', 'testing'],
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.policyContents).toEqual([
      'Clean code rules.',
      'Test everything.',
    ]);
  });

  it('should leave policyContents undefined when no policy specified', () => {
    const raw = {
      name: 'test-workflow',
      policies: {
        coding: 'Clean code rules.',
      },
      steps: [
        {
          name: 'step1',
          persona: 'coder',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.policyContents).toBeUndefined();
  });

  it('should treat unknown policy names as inline content', () => {
    const raw = {
      name: 'test-workflow',
      policies: {
        coding: 'Clean code rules.',
      },
      steps: [
        {
          name: 'step1',
          persona: 'coder',
          policy: 'nonexistent',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.policyContents).toEqual(['nonexistent']);
  });

  it('should resolve policies in parallel sub-steps', () => {
    const raw = {
      name: 'test-workflow',
      policies: {
        review: 'Be thorough.',
        coding: 'Write clean code.',
      },
      steps: [
        {
          name: 'reviewers',
          parallel: [
            {
              name: 'arch-review',
              persona: 'reviewer',
              policy: 'review',
              instruction: '{task}',
            },
            {
              name: 'code-fix',
              persona: 'coder',
              policy: ['coding', 'review'],
              instruction: '{task}',
            },
          ],
          rules: [{ condition: 'all("done")', next: 'COMPLETE' }],
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    const parallel = config.steps[0]!.parallel!;
    expect(parallel[0]!.policyContents).toEqual(['Be thorough.']);
    expect(parallel[1]!.policyContents).toEqual(['Write clean code.', 'Be thorough.']);
  });

  it('should leave config.policies undefined when no policies defined', () => {
    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'step1',
          persona: 'coder',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.policies).toBeUndefined();
  });
});

// --- policy injection in InstructionBuilder ---

describe('InstructionBuilder policy injection', () => {
  it('should inject policy content into instruction (JA)', () => {
    const step = {
      name: 'test-step',
      personaDisplayName: 'coder',
      instruction: 'Do the thing.',
      passPreviousResponse: false,
      policyContents: ['# Coding Policy\n\nWrite clean code.'],
    };

    const ctx = makeContext({ language: 'ja' });
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).toContain('## Policy');
    expect(result).toContain('# Coding Policy');
    expect(result).toContain('Write clean code.');
    expect(result).toContain('必ず遵守してください');
  });

  it('should inject policy content into instruction (EN)', () => {
    const step = {
      name: 'test-step',
      personaDisplayName: 'coder',
      instruction: 'Do the thing.',
      passPreviousResponse: false,
      policyContents: ['# Coding Policy\n\nWrite clean code.'],
    };

    const ctx = makeContext({ language: 'en' });
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).toContain('## Policy');
    expect(result).toContain('Write clean code.');
    expect(result).toContain('You MUST comply');
  });

  it('should not inject policy section when no policyContents', () => {
    const step = {
      name: 'test-step',
      personaDisplayName: 'coder',
      instruction: 'Do the thing.',
      passPreviousResponse: false,
    };

    const ctx = makeContext({ language: 'ja' });
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).not.toContain('## Policy');
  });

  it('should join multiple policies with separator', () => {
    const step = {
      name: 'test-step',
      personaDisplayName: 'coder',
      instruction: 'Do the thing.',
      passPreviousResponse: false,
      policyContents: ['Policy A content.', 'Policy B content.'],
    };

    const ctx = makeContext({ language: 'en' });
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).toContain('Policy A content.');
    expect(result).toContain('Policy B content.');
    expect(result).toContain('---');
  });

  it('should prefer context policyContents over step policyContents', () => {
    const step = {
      name: 'test-step',
      personaDisplayName: 'coder',
      instruction: 'Do the thing.',
      passPreviousResponse: false,
      policyContents: ['Step policy.'],
    };

    const ctx = makeContext({
      language: 'en',
      policyContents: ['Context policy.'],
    });
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).toContain('Context policy.');
    expect(result).not.toContain('Step policy.');
  });
});

// --- section reference tests ---

describe('section reference resolution', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
    // Create resource files
    mkdirSync(join(testDir, 'personas'), { recursive: true });
    mkdirSync(join(testDir, 'policies'), { recursive: true });
    mkdirSync(join(testDir, 'instructions'), { recursive: true });
    mkdirSync(join(testDir, 'output-contracts'), { recursive: true });

    writeFileSync(join(testDir, 'personas', 'coder.md'), '# Coder\nYou are a coder.');
    writeFileSync(join(testDir, 'policies', 'coding.md'), '# Coding Policy\nWrite clean code.');
    writeFileSync(join(testDir, 'policies', 'testing.md'), '# Testing Policy\nTest everything.');
    writeFileSync(join(testDir, 'instructions', 'implement.md'), 'Implement the feature.');
    writeFileSync(join(testDir, 'output-contracts', 'plan.md'), '# Plan Report\n## Goal\n{goal}');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should resolve persona from personas section by name', () => {
    const raw = {
      name: 'test-workflow',
      personas: { coder: './personas/coder.md' },
      steps: [{
        name: 'impl',
        persona: 'coder',
        instruction: '{task}',
      }],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.persona).toBe('./personas/coder.md');
    expect(config.steps[0]!.personaPath).toBe(join(testDir, 'personas', 'coder.md'));
  });

  it('should resolve policy from policies section by name', () => {
    const raw = {
      name: 'test-workflow',
      policies: { coding: './policies/coding.md' },
      steps: [{
        name: 'impl',
        persona: 'coder',
        policy: 'coding',
        instruction: '{task}',
      }],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.policyContents).toEqual(['# Coding Policy\nWrite clean code.']);
  });

  it('should resolve mixed policy array: [section-name, ./path]', () => {
    const raw = {
      name: 'test-workflow',
      policies: { coding: './policies/coding.md' },
      steps: [{
        name: 'impl',
        persona: 'coder',
        policy: ['coding', './policies/testing.md'],
        instruction: '{task}',
      }],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.policyContents).toEqual([
      '# Coding Policy\nWrite clean code.',
      '# Testing Policy\nTest everything.',
    ]);
  });

  it('should resolve instruction from instructions section by name', () => {
    const raw = {
      name: 'test-workflow',
      instructions: { implement: './instructions/implement.md' },
      steps: [{
        name: 'impl',
        persona: 'coder',
        instruction: 'implement',
      }],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.instruction).toBe('Implement the feature.');
  });

  it('should expose normalized step instruction on instruction field', () => {
    const raw = {
      name: 'test-workflow',
      steps: [{
        name: 'impl',
        persona: 'coder',
        instruction: 'Canonical step instruction',
      }],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    const step = config.steps[0] as unknown as Record<string, unknown>;
    expect(step.instruction).toBe('Canonical step instruction');
  });

  it('should resolve output contract from report_formats section by name', () => {
    const raw = {
      name: 'test-workflow',
      report_formats: { plan: './output-contracts/plan.md' },
      steps: [{
        name: 'plan',
        persona: 'planner',
        instruction: '{task}',
        output_contracts: {
          report: [{
            name: '00-plan.md',
            format: 'plan',
            use_judge: true,
          }],
        },
      }],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    const outputContract = config.steps[0]!.outputContracts![0] as { name: string; format?: string };
    expect(outputContract.format).toBe('# Plan Report\n## Goal\n{goal}');
  });

  it('should treat unresolved name as inline value (no section match)', () => {
    const raw = {
      name: 'test-workflow',
      steps: [{
        name: 'impl',
        persona: 'nonexistent',
        instruction: '{task}',
      }],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    // No matching section key → treated as inline persona spec
    expect(config.steps[0]!.persona).toBe('nonexistent');
  });

  it('should resolve instruction field from instructions section', () => {
    const raw = {
      name: 'test-workflow',
      instructions: { implement: './instructions/implement.md' },
      steps: [{
        name: 'impl',
        persona: 'coder',
        instruction: 'implement',
      }],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.instruction).toBe('Implement the feature.');
  });

  it('should fail fast when step uses instruction_template', () => {
    const raw = {
      name: 'test-workflow',
      steps: [{
        name: 'impl',
        persona: 'coder',
        instruction_template: 'Legacy step instruction',
      }],
    };

    expect(() => normalizeWorkflowConfig(raw, testDir)).toThrow();
  });

  it('should fail fast when loop monitor judge uses instruction_template', () => {
    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'step1',
          persona: 'coder',
          instruction: '{task}',
          rules: [{ condition: 'next', next: 'step2' }],
        },
        {
          name: 'step2',
          persona: 'coder',
          instruction: '{task}',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
      loop_monitors: [
        {
          cycle: ['step1', 'step2'],
          threshold: 2,
          judge: {
            persona: 'coder',
            instruction_template: 'Legacy judge instruction',
            rules: [{ condition: 'continue', next: 'step2' }],
          },
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, testDir)).toThrow();
  });

  it('should resolve loop monitor judge instruction from instructions section', () => {
    const raw = {
      name: 'test-workflow',
      instructions: { judge_template: './instructions/implement.md' },
      steps: [
        {
          name: 'step1',
          persona: 'coder',
          instruction: '{task}',
          rules: [{ condition: 'next', next: 'step2' }],
        },
        {
          name: 'step2',
          persona: 'coder',
          instruction: '{task}',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
      loop_monitors: [
        {
          cycle: ['step1', 'step2'],
          threshold: 2,
          judge: {
            persona: 'coder',
            instruction: 'judge_template',
            rules: [{ condition: 'continue', next: 'step2' }],
          },
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.loopMonitors?.[0]?.judge.instruction).toBe('Implement the feature.');
  });

  it('should expose normalized loop monitor judge instruction on instruction field', () => {
    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'step1',
          persona: 'coder',
          instruction: '{task}',
          rules: [{ condition: 'next', next: 'step2' }],
        },
        {
          name: 'step2',
          persona: 'coder',
          instruction: '{task}',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
      loop_monitors: [
        {
          cycle: ['step1', 'step2'],
          threshold: 2,
          judge: {
            persona: 'coder',
            instruction: 'Canonical judge instruction',
            rules: [{ condition: 'continue', next: 'step2' }],
          },
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    const judge = config.loopMonitors?.[0]?.judge as unknown as Record<string, unknown>;
    expect(judge.instruction).toBe('Canonical judge instruction');
  });

  it('should store resolved sections on WorkflowConfig', () => {
    const raw = {
      name: 'test-workflow',
      personas: { coder: './personas/coder.md' },
      policies: { coding: './policies/coding.md' },
      instructions: { implement: './instructions/implement.md' },
      report_formats: { plan: './output-contracts/plan.md' },
      steps: [{
        name: 'impl',
        persona: 'coder',
        instruction: '{task}',
      }],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.personas).toEqual({ coder: './personas/coder.md' });
    expect(config.policies).toEqual({ coding: '# Coding Policy\nWrite clean code.' });
    expect(config.instructions).toEqual({ implement: 'Implement the feature.' });
    expect(config.reportFormats).toEqual({ plan: '# Plan Report\n## Goal\n{goal}' });
  });

  it('should work with section references in parallel sub-steps', () => {
    const raw = {
      name: 'test-workflow',
      personas: { coder: './personas/coder.md' },
      policies: { coding: './policies/coding.md', testing: './policies/testing.md' },
      instructions: { implement: './instructions/implement.md' },
      steps: [{
        name: 'parallel-step',
        parallel: [
          {
            name: 'sub1',
            persona: 'coder',
            policy: 'coding',
            instruction: 'implement',
          },
          {
            name: 'sub2',
            persona: 'coder',
            policy: ['coding', 'testing'],
            instruction: '{task}',
          },
        ],
        rules: [{ condition: 'all("done")', next: 'COMPLETE' }],
      }],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    const parallel = config.steps[0]!.parallel!;
    expect(parallel[0]!.persona).toBe('./personas/coder.md');
    expect(parallel[0]!.policyContents).toEqual(['# Coding Policy\nWrite clean code.']);
    expect(parallel[0]!.instruction).toBe('Implement the feature.');
    expect(parallel[1]!.policyContents).toEqual([
      '# Coding Policy\nWrite clean code.',
      '# Testing Policy\nTest everything.',
    ]);
  });

  it('should resolve policy by plain name (primary mechanism)', () => {
    const raw = {
      name: 'test-workflow',
      policies: { coding: './policies/coding.md' },
      steps: [{
        name: 'impl',
        persona: 'coder',
        policy: 'coding',
        instruction: '{task}',
      }],
    };

    const config = normalizeWorkflowConfig(raw, testDir);
    expect(config.steps[0]!.policyContents).toEqual(['# Coding Policy\nWrite clean code.']);
  });
});
