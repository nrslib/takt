/**
 * Tests for knowledge category feature
 *
 * Covers:
 * - Schema validation for knowledge field at piece and movement level
 * - Piece parser resolution of knowledge references
 * - InstructionBuilder knowledge content injection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PieceConfigRawSchema,
  PieceMovementRawSchema,
  ParallelSubMovementRawSchema,
} from '../core/models/index.js';
import { normalizePieceConfig } from '../infra/config/loaders/pieceParser.js';
import { InstructionBuilder } from '../core/piece/instruction/InstructionBuilder.js';
import type { InstructionContext } from '../core/piece/instruction/instruction-context.js';
import type { PieceMovement } from '../core/models/types.js';

describe('PieceConfigRawSchema knowledge field', () => {
  it('should accept knowledge map at piece level', () => {
    const raw = {
      name: 'test-piece',
      knowledge: {
        frontend: 'frontend.md',
        backend: 'backend.md',
      },
      movements: [
        { name: 'step1', persona: 'coder.md', instruction: '{task}' },
      ],
    };

    const result = PieceConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge).toEqual({
        frontend: 'frontend.md',
        backend: 'backend.md',
      });
    }
  });

  it('should accept piece without knowledge field', () => {
    const raw = {
      name: 'test-piece',
      movements: [
        { name: 'step1', persona: 'coder.md', instruction: '{task}' },
      ],
    };

    const result = PieceConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge).toBeUndefined();
    }
  });
});

describe('PieceMovementRawSchema knowledge field', () => {
  it('should accept knowledge as a string reference', () => {
    const raw = {
      name: 'implement',
      persona: 'coder.md',
      knowledge: 'frontend',
      instruction: '{task}',
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge).toBe('frontend');
    }
  });

  it('should accept knowledge as array of string references', () => {
    const raw = {
      name: 'implement',
      persona: 'coder.md',
      knowledge: ['frontend', 'backend'],
      instruction: '{task}',
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge).toEqual(['frontend', 'backend']);
    }
  });

  it('should accept movement without knowledge field', () => {
    const raw = {
      name: 'implement',
      persona: 'coder.md',
      instruction: '{task}',
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge).toBeUndefined();
    }
  });

  it('should accept both policy and knowledge fields', () => {
    const raw = {
      name: 'implement',
      persona: 'coder.md',
      policy: 'coding',
      knowledge: 'frontend',
      instruction: '{task}',
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.policy).toBe('coding');
      expect(result.data.knowledge).toBe('frontend');
    }
  });
});

describe('ParallelSubMovementRawSchema knowledge field', () => {
  it('should accept knowledge on parallel sub-movements', () => {
    const raw = {
      name: 'sub-step',
      persona: 'reviewer.md',
      knowledge: 'security',
      instruction_template: 'Review security',
    };

    const result = ParallelSubMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge).toBe('security');
    }
  });

  it('should accept knowledge array on parallel sub-movements', () => {
    const raw = {
      name: 'sub-step',
      persona: 'reviewer.md',
      knowledge: ['security', 'performance'],
      instruction_template: 'Review',
    };

    const result = ParallelSubMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge).toEqual(['security', 'performance']);
    }
  });
});

describe('normalizePieceConfig knowledge resolution', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-knowledge-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should resolve knowledge from piece-level map to movement', () => {
    const frontendKnowledge = '# Frontend Knowledge\n\nUse React for components.';
    writeFileSync(join(tempDir, 'frontend.md'), frontendKnowledge);

    const raw = {
      name: 'test-piece',
      knowledge: {
        frontend: 'frontend.md',
      },
      movements: [
        {
          name: 'implement',
          persona: 'coder.md',
          knowledge: 'frontend',
          instruction: '{task}',
        },
      ],
    };

    const piece = normalizePieceConfig(raw, tempDir);

    expect(piece.knowledge).toBeDefined();
    expect(piece.knowledge!['frontend']).toBe(frontendKnowledge);
    expect(piece.movements[0].knowledgeContents).toEqual([frontendKnowledge]);
  });

  it('should resolve multiple knowledge references', () => {
    const frontendKnowledge = '# Frontend\nReact patterns.';
    const backendKnowledge = '# Backend\nAPI design.';
    writeFileSync(join(tempDir, 'frontend.md'), frontendKnowledge);
    writeFileSync(join(tempDir, 'backend.md'), backendKnowledge);

    const raw = {
      name: 'test-piece',
      knowledge: {
        frontend: 'frontend.md',
        backend: 'backend.md',
      },
      movements: [
        {
          name: 'implement',
          persona: 'coder.md',
          knowledge: ['frontend', 'backend'],
          instruction: '{task}',
        },
      ],
    };

    const piece = normalizePieceConfig(raw, tempDir);

    expect(piece.movements[0].knowledgeContents).toHaveLength(2);
    expect(piece.movements[0].knowledgeContents).toContain(frontendKnowledge);
    expect(piece.movements[0].knowledgeContents).toContain(backendKnowledge);
  });

  it('should resolve knowledge on parallel sub-movements', () => {
    const securityKnowledge = '# Security\nOWASP guidelines.';
    writeFileSync(join(tempDir, 'security.md'), securityKnowledge);

    const raw = {
      name: 'test-piece',
      knowledge: {
        security: 'security.md',
      },
      movements: [
        {
          name: 'review',
          parallel: [
            {
              name: 'sec-review',
              persona: 'reviewer.md',
              knowledge: 'security',
              instruction_template: 'Review security',
            },
          ],
          rules: [{ condition: 'approved', next: 'COMPLETE' }],
        },
      ],
    };

    const piece = normalizePieceConfig(raw, tempDir);

    expect(piece.movements[0].parallel).toHaveLength(1);
    expect(piece.movements[0].parallel![0].knowledgeContents).toEqual([securityKnowledge]);
  });

  it('should handle inline knowledge content', () => {
    const raw = {
      name: 'test-piece',
      knowledge: {
        inline: 'This is inline knowledge content.',
      },
      movements: [
        {
          name: 'implement',
          persona: 'coder.md',
          knowledge: 'inline',
          instruction: '{task}',
        },
      ],
    };

    const piece = normalizePieceConfig(raw, tempDir);

    expect(piece.knowledge!['inline']).toBe('This is inline knowledge content.');
    expect(piece.movements[0].knowledgeContents).toEqual(['This is inline knowledge content.']);
  });

  it('should handle direct file path reference without piece-level map', () => {
    const directKnowledge = '# Direct Knowledge\nLoaded directly.';
    writeFileSync(join(tempDir, 'direct.md'), directKnowledge);

    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'implement',
          persona: 'coder.md',
          knowledge: 'direct.md',
          instruction: '{task}',
        },
      ],
    };

    const piece = normalizePieceConfig(raw, tempDir);

    expect(piece.movements[0].knowledgeContents).toEqual([directKnowledge]);
  });

  it('should treat non-file reference as inline content when knowledge reference not found in map', () => {
    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'implement',
          persona: 'coder.md',
          knowledge: 'nonexistent',
          instruction: '{task}',
        },
      ],
    };

    const piece = normalizePieceConfig(raw, tempDir);

    // Non-.md references that are not in the knowledge map are treated as inline content
    expect(piece.movements[0].knowledgeContents).toEqual(['nonexistent']);
  });
});

// --- Test helpers for InstructionBuilder ---

function createMinimalStep(instructionTemplate: string): PieceMovement {
  return {
    name: 'test-step',
    personaDisplayName: 'coder',
    instructionTemplate,
    passPreviousResponse: false,
  };
}

function createMinimalContext(overrides: Partial<InstructionContext> = {}): InstructionContext {
  return {
    task: 'Test task',
    iteration: 1,
    maxMovements: 10,
    movementIteration: 1,
    cwd: '/tmp/test',
    projectCwd: '/tmp/test',
    userInputs: [],
    language: 'ja',
    ...overrides,
  };
}

// --- InstructionBuilder knowledge injection tests ---

describe('InstructionBuilder knowledge injection', () => {
  it('should inject knowledge section when knowledgeContents present in step', () => {
    const step = createMinimalStep('{task}');
    step.knowledgeContents = ['# Frontend Knowledge\n\nUse React.'];
    const ctx = createMinimalContext();
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).toContain('## Knowledge');
    expect(result).toContain('Frontend Knowledge');
    expect(result).toContain('Use React.');
  });

  it('should not inject knowledge section when no knowledgeContents', () => {
    const step = createMinimalStep('{task}');
    const ctx = createMinimalContext();
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).not.toContain('## Knowledge');
  });

  it('should prefer context knowledgeContents over step knowledgeContents', () => {
    const step = createMinimalStep('{task}');
    step.knowledgeContents = ['Step knowledge.'];
    const ctx = createMinimalContext({
      knowledgeContents: ['Context knowledge.'],
    });
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).toContain('Context knowledge.');
    expect(result).not.toContain('Step knowledge.');
  });

  it('should join multiple knowledge contents with separator', () => {
    const step = createMinimalStep('{task}');
    step.knowledgeContents = ['Knowledge A content.', 'Knowledge B content.'];
    const ctx = createMinimalContext();
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).toContain('Knowledge A content.');
    expect(result).toContain('Knowledge B content.');
    expect(result).toContain('---');
  });

  it('should inject knowledge section in English', () => {
    const step = createMinimalStep('{task}');
    step.knowledgeContents = ['# API Guidelines\n\nUse REST conventions.'];
    const ctx = createMinimalContext({ language: 'en' });
    const builder = new InstructionBuilder(step, ctx);
    const result = builder.build();

    expect(result).toContain('## Knowledge');
    expect(result).toContain('API Guidelines');
  });
});

describe('knowledge and policy coexistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-knowledge-policy-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should resolve both policy and knowledge for same movement', () => {
    const policyContent = '# Coding Policy\nWrite clean code.';
    const knowledgeContent = '# Frontend Knowledge\nUse TypeScript.';
    writeFileSync(join(tempDir, 'coding.md'), policyContent);
    writeFileSync(join(tempDir, 'frontend.md'), knowledgeContent);

    const raw = {
      name: 'test-piece',
      policies: {
        coding: 'coding.md',
      },
      knowledge: {
        frontend: 'frontend.md',
      },
      movements: [
        {
          name: 'implement',
          persona: 'coder.md',
          policy: 'coding',
          knowledge: 'frontend',
          instruction: '{task}',
        },
      ],
    };

    const piece = normalizePieceConfig(raw, tempDir);

    expect(piece.policies!['coding']).toBe(policyContent);
    expect(piece.knowledge!['frontend']).toBe(knowledgeContent);
    expect(piece.movements[0].policyContents).toEqual([policyContent]);
    expect(piece.movements[0].knowledgeContents).toEqual([knowledgeContent]);
  });
});
