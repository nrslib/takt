/**
 * Tests for stance and persona features.
 *
 * Covers:
 * - persona/persona_name fields in piece YAML (with agent/agent_name backward compat)
 * - Piece-level stances definition and resolution
 * - Movement-level stance references
 * - Stance injection in InstructionBuilder
 * - File-based stance content loading via resolveContentPath
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizePieceConfig } from '../infra/config/loaders/pieceParser.js';
import { InstructionBuilder } from '../core/piece/instruction/InstructionBuilder.js';
import type { InstructionContext } from '../core/piece/instruction/instruction-context.js';

// --- Test helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'takt-stance-'));
}

function makeContext(overrides: Partial<InstructionContext> = {}): InstructionContext {
  return {
    task: 'Test task',
    iteration: 1,
    maxIterations: 10,
    movementIteration: 1,
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
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'inline-prompt-text',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.persona).toBe('inline-prompt-text');
  });

  it('should prefer persona over agent when both specified', () => {
    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'new-persona',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.persona).toBe('new-persona');
  });

  it('should have undefined persona when persona not specified', () => {
    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.persona).toBeUndefined();
  });

  it('should treat persona_name as display name', () => {
    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'some-prompt',
          persona_name: 'My Persona',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.personaDisplayName).toBe('My Persona');
  });

  it('should use persona_name as display name', () => {
    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'some-persona',
          persona_name: 'New Name',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.personaDisplayName).toBe('New Name');
  });

  it('should resolve persona .md file path like agent', () => {
    const agentFile = join(testDir, 'my-persona.md');
    writeFileSync(agentFile, '# Test Persona\nYou are a test persona.');

    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: './my-persona.md',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.persona).toBe('./my-persona.md');
    expect(config.movements[0]!.personaPath).toBe(agentFile);
  });

  it('should work with persona in parallel sub-movements', () => {
    const raw = {
      name: 'test-piece',
      movements: [
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

    const config = normalizePieceConfig(raw, testDir);
    const parallel = config.movements[0]!.parallel!;
    expect(parallel[0]!.persona).toBe('sub-persona-1');
    expect(parallel[1]!.persona).toBe('sub-persona-2');
    expect(parallel[1]!.personaDisplayName).toBe('Sub Persona 2');
  });
});

// --- stance tests ---

describe('stances', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should resolve piece-level stances from inline content', () => {
    const raw = {
      name: 'test-piece',
      stances: {
        coding: 'Always write clean code.',
        review: 'Be thorough in reviews.',
      },
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          stance: 'coding',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.stances).toEqual({
      coding: 'Always write clean code.',
      review: 'Be thorough in reviews.',
    });
    expect(config.movements[0]!.stanceContents).toEqual(['Always write clean code.']);
  });

  it('should resolve stances from .md file paths', () => {
    const stancesDir = join(testDir, 'stances');
    mkdirSync(stancesDir, { recursive: true });
    writeFileSync(join(stancesDir, 'coding.md'), '# Coding Stance\n\nWrite clean code.');
    writeFileSync(join(stancesDir, 'review.md'), '# Review Stance\n\nBe thorough.');

    const raw = {
      name: 'test-piece',
      stances: {
        coding: './stances/coding.md',
        review: './stances/review.md',
      },
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          stance: 'coding',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.stances!['coding']).toBe('# Coding Stance\n\nWrite clean code.');
    expect(config.stances!['review']).toBe('# Review Stance\n\nBe thorough.');
    expect(config.movements[0]!.stanceContents).toEqual(['# Coding Stance\n\nWrite clean code.']);
  });

  it('should support multiple stance references (array)', () => {
    const raw = {
      name: 'test-piece',
      stances: {
        coding: 'Clean code rules.',
        testing: 'Test everything.',
      },
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          stance: ['coding', 'testing'],
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.stanceContents).toEqual([
      'Clean code rules.',
      'Test everything.',
    ]);
  });

  it('should leave stanceContents undefined when no stance specified', () => {
    const raw = {
      name: 'test-piece',
      stances: {
        coding: 'Clean code rules.',
      },
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.stanceContents).toBeUndefined();
  });

  it('should leave stanceContents undefined for unknown stance names', () => {
    const raw = {
      name: 'test-piece',
      stances: {
        coding: 'Clean code rules.',
      },
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          stance: 'nonexistent',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.stanceContents).toBeUndefined();
  });

  it('should resolve stances in parallel sub-movements', () => {
    const raw = {
      name: 'test-piece',
      stances: {
        review: 'Be thorough.',
        coding: 'Write clean code.',
      },
      movements: [
        {
          name: 'reviewers',
          parallel: [
            {
              name: 'arch-review',
              persona: 'reviewer',
              stance: 'review',
              instruction: '{task}',
            },
            {
              name: 'code-fix',
              persona: 'coder',
              stance: ['coding', 'review'],
              instruction: '{task}',
            },
          ],
          rules: [{ condition: 'all("done")', next: 'COMPLETE' }],
        },
      ],
    };

    const config = normalizePieceConfig(raw, testDir);
    const parallel = config.movements[0]!.parallel!;
    expect(parallel[0]!.stanceContents).toEqual(['Be thorough.']);
    expect(parallel[1]!.stanceContents).toEqual(['Write clean code.', 'Be thorough.']);
  });

  it('should leave config.stances undefined when no stances defined', () => {
    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.stances).toBeUndefined();
  });
});

// --- stance injection in InstructionBuilder ---

describe('InstructionBuilder stance injection', () => {
  it('should inject stance content into instruction (JA)', () => {
    const step = {
      name: 'test-step',
      personaDisplayName: 'coder',
      instructionTemplate: 'Do the thing.',
      passPreviousResponse: false,
      stanceContents: ['# Coding Stance\n\nWrite clean code.'],
    };

    const ctx = makeContext({ language: 'ja' });
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).toContain('## Stance');
    expect(result).toContain('# Coding Stance');
    expect(result).toContain('Write clean code.');
    expect(result).toContain('Stance Reminder');
  });

  it('should inject stance content into instruction (EN)', () => {
    const step = {
      name: 'test-step',
      personaDisplayName: 'coder',
      instructionTemplate: 'Do the thing.',
      passPreviousResponse: false,
      stanceContents: ['# Coding Stance\n\nWrite clean code.'],
    };

    const ctx = makeContext({ language: 'en' });
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).toContain('## Stance');
    expect(result).toContain('Write clean code.');
    expect(result).toContain('Stance Reminder');
  });

  it('should not inject stance section when no stanceContents', () => {
    const step = {
      name: 'test-step',
      personaDisplayName: 'coder',
      instructionTemplate: 'Do the thing.',
      passPreviousResponse: false,
    };

    const ctx = makeContext({ language: 'ja' });
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).not.toContain('## Stance');
    expect(result).not.toContain('Stance Reminder');
  });

  it('should join multiple stances with separator', () => {
    const step = {
      name: 'test-step',
      personaDisplayName: 'coder',
      instructionTemplate: 'Do the thing.',
      passPreviousResponse: false,
      stanceContents: ['Stance A content.', 'Stance B content.'],
    };

    const ctx = makeContext({ language: 'en' });
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).toContain('Stance A content.');
    expect(result).toContain('Stance B content.');
    expect(result).toContain('---');
  });

  it('should prefer context stanceContents over step stanceContents', () => {
    const step = {
      name: 'test-step',
      personaDisplayName: 'coder',
      instructionTemplate: 'Do the thing.',
      passPreviousResponse: false,
      stanceContents: ['Step stance.'],
    };

    const ctx = makeContext({
      language: 'en',
      stanceContents: ['Context stance.'],
    });
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).toContain('Context stance.');
    expect(result).not.toContain('Step stance.');
  });
});

// --- section reference tests ---

describe('section reference resolution', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
    // Create resource files
    mkdirSync(join(testDir, 'personas'), { recursive: true });
    mkdirSync(join(testDir, 'stances'), { recursive: true });
    mkdirSync(join(testDir, 'instructions'), { recursive: true });
    mkdirSync(join(testDir, 'report-formats'), { recursive: true });

    writeFileSync(join(testDir, 'personas', 'coder.md'), '# Coder\nYou are a coder.');
    writeFileSync(join(testDir, 'stances', 'coding.md'), '# Coding Stance\nWrite clean code.');
    writeFileSync(join(testDir, 'stances', 'testing.md'), '# Testing Stance\nTest everything.');
    writeFileSync(join(testDir, 'instructions', 'implement.md'), 'Implement the feature.');
    writeFileSync(join(testDir, 'report-formats', 'plan.md'), '# Plan Report\n## Goal\n{goal}');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should resolve persona from personas section by name', () => {
    const raw = {
      name: 'test-piece',
      personas: { coder: './personas/coder.md' },
      movements: [{
        name: 'impl',
        persona: 'coder',
        instruction: '{task}',
      }],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.persona).toBe('./personas/coder.md');
    expect(config.movements[0]!.personaPath).toBe(join(testDir, 'personas', 'coder.md'));
  });

  it('should resolve stance from stances section by name', () => {
    const raw = {
      name: 'test-piece',
      stances: { coding: './stances/coding.md' },
      movements: [{
        name: 'impl',
        persona: 'coder',
        stance: 'coding',
        instruction: '{task}',
      }],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.stanceContents).toEqual(['# Coding Stance\nWrite clean code.']);
  });

  it('should resolve mixed stance array: [section-name, ./path]', () => {
    const raw = {
      name: 'test-piece',
      stances: { coding: './stances/coding.md' },
      movements: [{
        name: 'impl',
        persona: 'coder',
        stance: ['coding', './stances/testing.md'],
        instruction: '{task}',
      }],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.stanceContents).toEqual([
      '# Coding Stance\nWrite clean code.',
      '# Testing Stance\nTest everything.',
    ]);
  });

  it('should resolve instruction from instructions section by name', () => {
    const raw = {
      name: 'test-piece',
      instructions: { implement: './instructions/implement.md' },
      movements: [{
        name: 'impl',
        persona: 'coder',
        instruction: 'implement',
      }],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.instructionTemplate).toBe('Implement the feature.');
  });

  it('should resolve report format from report_formats section by name', () => {
    const raw = {
      name: 'test-piece',
      report_formats: { plan: './report-formats/plan.md' },
      movements: [{
        name: 'plan',
        persona: 'planner',
        instruction: '{task}',
        report: {
          name: '00-plan.md',
          format: 'plan',
        },
      }],
    };

    const config = normalizePieceConfig(raw, testDir);
    const report = config.movements[0]!.report as { name: string; format?: string };
    expect(report.format).toBe('# Plan Report\n## Goal\n{goal}');
  });

  it('should treat unresolved name as inline value (no section match)', () => {
    const raw = {
      name: 'test-piece',
      movements: [{
        name: 'impl',
        persona: 'nonexistent',
        instruction: '{task}',
      }],
    };

    const config = normalizePieceConfig(raw, testDir);
    // No matching section key → treated as inline persona spec
    expect(config.movements[0]!.persona).toBe('nonexistent');
  });

  it('should prefer instruction_template over instruction section reference', () => {
    const raw = {
      name: 'test-piece',
      instructions: { implement: './instructions/implement.md' },
      movements: [{
        name: 'impl',
        persona: 'coder',
        instruction: 'implement',
        instruction_template: 'Inline template takes priority.',
      }],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.instructionTemplate).toBe('Inline template takes priority.');
  });

  it('should store resolved sections on PieceConfig', () => {
    const raw = {
      name: 'test-piece',
      personas: { coder: './personas/coder.md' },
      stances: { coding: './stances/coding.md' },
      instructions: { implement: './instructions/implement.md' },
      report_formats: { plan: './report-formats/plan.md' },
      movements: [{
        name: 'impl',
        persona: 'coder',
        instruction: '{task}',
      }],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.personas).toEqual({ coder: './personas/coder.md' });
    expect(config.stances).toEqual({ coding: '# Coding Stance\nWrite clean code.' });
    expect(config.instructions).toEqual({ implement: 'Implement the feature.' });
    expect(config.reportFormats).toEqual({ plan: '# Plan Report\n## Goal\n{goal}' });
  });

  it('should work with section references in parallel sub-movements', () => {
    const raw = {
      name: 'test-piece',
      personas: { coder: './personas/coder.md' },
      stances: { coding: './stances/coding.md', testing: './stances/testing.md' },
      instructions: { implement: './instructions/implement.md' },
      movements: [{
        name: 'parallel-step',
        parallel: [
          {
            name: 'sub1',
            persona: 'coder',
            stance: 'coding',
            instruction: 'implement',
          },
          {
            name: 'sub2',
            persona: 'coder',
            stance: ['coding', 'testing'],
            instruction: '{task}',
          },
        ],
        rules: [{ condition: 'all("done")', next: 'COMPLETE' }],
      }],
    };

    const config = normalizePieceConfig(raw, testDir);
    const parallel = config.movements[0]!.parallel!;
    expect(parallel[0]!.persona).toBe('./personas/coder.md');
    expect(parallel[0]!.stanceContents).toEqual(['# Coding Stance\nWrite clean code.']);
    expect(parallel[0]!.instructionTemplate).toBe('Implement the feature.');
    expect(parallel[1]!.stanceContents).toEqual([
      '# Coding Stance\nWrite clean code.',
      '# Testing Stance\nTest everything.',
    ]);
  });

  it('should resolve stance by plain name (primary mechanism)', () => {
    const raw = {
      name: 'test-piece',
      stances: { coding: './stances/coding.md' },
      movements: [{
        name: 'impl',
        persona: 'coder',
        stance: 'coding',
        instruction: '{task}',
      }],
    };

    const config = normalizePieceConfig(raw, testDir);
    expect(config.movements[0]!.stanceContents).toEqual(['# Coding Stance\nWrite clean code.']);
  });
});
