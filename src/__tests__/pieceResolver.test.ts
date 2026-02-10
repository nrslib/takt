/**
 * Tests for getPieceDescription, buildWorkflowString, and buildMovementPreviews
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPieceDescription } from '../infra/config/loaders/pieceResolver.js';

describe('getPieceDescription', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-piece-resolver-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return workflow structure with sequential movements', () => {
    const pieceYaml = `name: test-piece
description: Test piece for workflow
initial_movement: plan
max_movements: 3

movements:
  - name: plan
    description: タスク計画
    persona: planner
    instruction: "Plan the task"
  - name: implement
    description: 実装
    persona: coder
    instruction: "Implement"
  - name: review
    persona: reviewer
    instruction: "Review"
`;

    const piecePath = join(tempDir, 'test.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir);

    expect(result.name).toBe('test-piece');
    expect(result.description).toBe('Test piece for workflow');
    expect(result.pieceStructure).toBe(
      '1. plan (タスク計画)\n2. implement (実装)\n3. review'
    );
    expect(result.movementPreviews).toEqual([]);
  });

  it('should return workflow structure with parallel movements', () => {
    const pieceYaml = `name: coding
description: Full coding workflow
initial_movement: plan
max_movements: 10

movements:
  - name: plan
    description: タスク計画
    persona: planner
    instruction: "Plan"
  - name: reviewers
    description: 並列レビュー
    parallel:
      - name: ai_review
        persona: ai-reviewer
        instruction: "AI review"
      - name: arch_review
        persona: arch-reviewer
        instruction: "Architecture review"
  - name: fix
    description: 修正
    persona: coder
    instruction: "Fix"
`;

    const piecePath = join(tempDir, 'coding.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir);

    expect(result.name).toBe('coding');
    expect(result.description).toBe('Full coding workflow');
    expect(result.pieceStructure).toBe(
      '1. plan (タスク計画)\n' +
      '2. reviewers (並列レビュー)\n' +
      '   - ai_review\n' +
      '   - arch_review\n' +
      '3. fix (修正)'
    );
    expect(result.movementPreviews).toEqual([]);
  });

  it('should handle movements without descriptions', () => {
    const pieceYaml = `name: minimal
initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: coder
    instruction: "Do step1"
  - name: step2
    persona: coder
    instruction: "Do step2"
`;

    const piecePath = join(tempDir, 'minimal.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir);

    expect(result.name).toBe('minimal');
    expect(result.description).toBe('');
    expect(result.pieceStructure).toBe('1. step1\n2. step2');
    expect(result.movementPreviews).toEqual([]);
  });

  it('should return empty strings when piece is not found', () => {
    const result = getPieceDescription('nonexistent', tempDir);

    expect(result.name).toBe('nonexistent');
    expect(result.description).toBe('');
    expect(result.pieceStructure).toBe('');
    expect(result.movementPreviews).toEqual([]);
  });

  it('should handle parallel movements without descriptions', () => {
    const pieceYaml = `name: test-parallel
initial_movement: parent
max_movements: 1

movements:
  - name: parent
    parallel:
      - name: child1
        persona: agent1
        instruction: "Do child1"
      - name: child2
        persona: agent2
        instruction: "Do child2"
`;

    const piecePath = join(tempDir, 'test-parallel.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir);

    expect(result.pieceStructure).toBe(
      '1. parent\n' +
      '   - child1\n' +
      '   - child2'
    );
    expect(result.movementPreviews).toEqual([]);
  });
});

describe('getPieceDescription with movementPreviews', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-previews-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return movement previews when previewCount is specified', () => {
    const pieceYaml = `name: preview-test
description: Test piece
initial_movement: plan
max_movements: 5

movements:
  - name: plan
    description: Planning
    persona: Plan the task
    instruction: "Create a plan for {task}"
    allowed_tools:
      - Read
      - Glob
    rules:
      - condition: plan complete
        next: implement
  - name: implement
    description: Implementation
    persona: Implement the code
    instruction: "Implement according to plan"
    edit: true
    allowed_tools:
      - Read
      - Edit
      - Bash
    rules:
      - condition: done
        next: review
  - name: review
    persona: Review the code
    instruction: "Review changes"
    rules:
      - condition: approved
        next: COMPLETE
`;

    const piecePath = join(tempDir, 'preview-test.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir, 3);

    expect(result.movementPreviews).toHaveLength(3);

    // First movement: plan
    expect(result.movementPreviews[0].name).toBe('plan');
    expect(result.movementPreviews[0].personaContent).toBe('Plan the task');
    expect(result.movementPreviews[0].instructionContent).toBe('Create a plan for {task}');
    expect(result.movementPreviews[0].allowedTools).toEqual(['Read', 'Glob']);
    expect(result.movementPreviews[0].canEdit).toBe(false);

    // Second movement: implement
    expect(result.movementPreviews[1].name).toBe('implement');
    expect(result.movementPreviews[1].personaContent).toBe('Implement the code');
    expect(result.movementPreviews[1].instructionContent).toBe('Implement according to plan');
    expect(result.movementPreviews[1].allowedTools).toEqual(['Read', 'Edit', 'Bash']);
    expect(result.movementPreviews[1].canEdit).toBe(true);

    // Third movement: review
    expect(result.movementPreviews[2].name).toBe('review');
    expect(result.movementPreviews[2].personaContent).toBe('Review the code');
    expect(result.movementPreviews[2].canEdit).toBe(false);
  });

  it('should return empty previews when previewCount is 0', () => {
    const pieceYaml = `name: test
initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: agent
    instruction: "Do step1"
`;

    const piecePath = join(tempDir, 'test.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir, 0);

    expect(result.movementPreviews).toEqual([]);
  });

  it('should return empty previews when previewCount is not specified', () => {
    const pieceYaml = `name: test
initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: agent
    instruction: "Do step1"
`;

    const piecePath = join(tempDir, 'test.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir);

    expect(result.movementPreviews).toEqual([]);
  });

  it('should stop at COMPLETE movement', () => {
    const pieceYaml = `name: test-complete
initial_movement: step1
max_movements: 3

movements:
  - name: step1
    persona: agent1
    instruction: "Step 1"
    rules:
      - condition: done
        next: COMPLETE
  - name: step2
    persona: agent2
    instruction: "Step 2"
`;

    const piecePath = join(tempDir, 'test-complete.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir, 5);

    expect(result.movementPreviews).toHaveLength(1);
    expect(result.movementPreviews[0].name).toBe('step1');
  });

  it('should stop at ABORT movement', () => {
    const pieceYaml = `name: test-abort
initial_movement: step1
max_movements: 3

movements:
  - name: step1
    persona: agent1
    instruction: "Step 1"
    rules:
      - condition: abort
        next: ABORT
  - name: step2
    persona: agent2
    instruction: "Step 2"
`;

    const piecePath = join(tempDir, 'test-abort.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir, 5);

    expect(result.movementPreviews).toHaveLength(1);
    expect(result.movementPreviews[0].name).toBe('step1');
  });

  it('should read persona content from file when personaPath is set', () => {
    const personaContent = '# Planner Persona\nYou are a planning expert.';
    const personaPath = join(tempDir, 'planner.md');
    writeFileSync(personaPath, personaContent);

    const pieceYaml = `name: test-persona-file
initial_movement: plan
max_movements: 1

personas:
  planner: ./planner.md

movements:
  - name: plan
    persona: planner
    instruction: "Plan the task"
`;

    const piecePath = join(tempDir, 'test-persona-file.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir, 1);

    expect(result.movementPreviews).toHaveLength(1);
    expect(result.movementPreviews[0].name).toBe('plan');
    expect(result.movementPreviews[0].personaContent).toBe(personaContent);
  });

  it('should limit previews to maxCount', () => {
    const pieceYaml = `name: test-limit
initial_movement: step1
max_movements: 5

movements:
  - name: step1
    persona: agent1
    instruction: "Step 1"
    rules:
      - condition: done
        next: step2
  - name: step2
    persona: agent2
    instruction: "Step 2"
    rules:
      - condition: done
        next: step3
  - name: step3
    persona: agent3
    instruction: "Step 3"
`;

    const piecePath = join(tempDir, 'test-limit.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir, 2);

    expect(result.movementPreviews).toHaveLength(2);
    expect(result.movementPreviews[0].name).toBe('step1');
    expect(result.movementPreviews[1].name).toBe('step2');
  });

  it('should handle movements without rules (stop after first)', () => {
    const pieceYaml = `name: test-no-rules
initial_movement: step1
max_movements: 3

movements:
  - name: step1
    persona: agent1
    instruction: "Step 1"
  - name: step2
    persona: agent2
    instruction: "Step 2"
`;

    const piecePath = join(tempDir, 'test-no-rules.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir, 3);

    expect(result.movementPreviews).toHaveLength(1);
    expect(result.movementPreviews[0].name).toBe('step1');
  });

  it('should return empty previews when initial movement not found in list', () => {
    const pieceYaml = `name: test-missing-initial
initial_movement: nonexistent
max_movements: 1

movements:
  - name: step1
    persona: agent
    instruction: "Do something"
`;

    const piecePath = join(tempDir, 'test-missing-initial.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir, 3);

    expect(result.movementPreviews).toEqual([]);
  });

  it('should handle self-referencing rule (prevent infinite loop)', () => {
    const pieceYaml = `name: test-self-ref
initial_movement: step1
max_movements: 5

movements:
  - name: step1
    persona: agent1
    instruction: "Step 1"
    rules:
      - condition: loop
        next: step1
`;

    const piecePath = join(tempDir, 'test-self-ref.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir, 5);

    expect(result.movementPreviews).toHaveLength(1);
    expect(result.movementPreviews[0].name).toBe('step1');
  });

  it('should handle multi-node cycle A→B→A (prevent duplicate previews)', () => {
    const pieceYaml = `name: test-cycle
initial_movement: stepA
max_movements: 10

movements:
  - name: stepA
    persona: agentA
    instruction: "Step A"
    rules:
      - condition: next
        next: stepB
  - name: stepB
    persona: agentB
    instruction: "Step B"
    rules:
      - condition: back
        next: stepA
`;

    const piecePath = join(tempDir, 'test-cycle.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir, 10);

    expect(result.movementPreviews).toHaveLength(2);
    expect(result.movementPreviews[0].name).toBe('stepA');
    expect(result.movementPreviews[1].name).toBe('stepB');
  });

  it('should return empty movementPreviews when piece is not found', () => {
    const result = getPieceDescription('nonexistent', tempDir, 3);

    expect(result.movementPreviews).toEqual([]);
  });

  it('should use inline persona content when no personaPath', () => {
    const pieceYaml = `name: test-inline
initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: You are an inline persona
    instruction: "Do something"
`;

    const piecePath = join(tempDir, 'test-inline.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir, 1);

    expect(result.movementPreviews).toHaveLength(1);
    expect(result.movementPreviews[0].personaContent).toBe('You are an inline persona');
  });

  it('should fallback to empty personaContent when personaPath file becomes unreadable', () => {
    // Create the persona file so it passes existsSync during parsing
    const personaPath = join(tempDir, 'unreadable-persona.md');
    writeFileSync(personaPath, '# Persona content');
    // Make the file unreadable so readFileSync fails in buildMovementPreviews
    chmodSync(personaPath, 0o000);

    const pieceYaml = `name: test-unreadable-persona
initial_movement: plan
max_movements: 1

personas:
  planner: ./unreadable-persona.md

movements:
  - name: plan
    persona: planner
    instruction: "Plan the task"
`;

    const piecePath = join(tempDir, 'test-unreadable-persona.yaml');
    writeFileSync(piecePath, pieceYaml);

    try {
      const result = getPieceDescription(piecePath, tempDir, 1);

      expect(result.movementPreviews).toHaveLength(1);
      expect(result.movementPreviews[0].name).toBe('plan');
      expect(result.movementPreviews[0].personaContent).toBe('');
      expect(result.movementPreviews[0].instructionContent).toBe('Plan the task');
    } finally {
      // Restore permissions so cleanup can remove the file
      chmodSync(personaPath, 0o644);
    }
  });

  it('should include personaDisplayName in previews', () => {
    const pieceYaml = `name: test-display
initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: agent
    persona_name: Custom Agent Name
    instruction: "Do something"
`;

    const piecePath = join(tempDir, 'test-display.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir, 1);

    expect(result.movementPreviews).toHaveLength(1);
    expect(result.movementPreviews[0].personaDisplayName).toBe('Custom Agent Name');
  });
});

describe('getPieceDescription interactiveMode field', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-interactive-mode-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return interactiveMode when piece defines interactive_mode', () => {
    const pieceYaml = `name: test-mode
initial_movement: step1
max_movements: 1
interactive_mode: quiet

movements:
  - name: step1
    persona: agent
    instruction: "Do something"
`;

    const piecePath = join(tempDir, 'test-mode.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir);

    expect(result.interactiveMode).toBe('quiet');
  });

  it('should return undefined interactiveMode when piece omits interactive_mode', () => {
    const pieceYaml = `name: test-no-mode
initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: agent
    instruction: "Do something"
`;

    const piecePath = join(tempDir, 'test-no-mode.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir);

    expect(result.interactiveMode).toBeUndefined();
  });

  it('should return interactiveMode for each valid mode value', () => {
    for (const mode of ['assistant', 'persona', 'quiet', 'passthrough'] as const) {
      const pieceYaml = `name: test-${mode}
initial_movement: step1
max_movements: 1
interactive_mode: ${mode}

movements:
  - name: step1
    persona: agent
    instruction: "Do something"
`;

      const piecePath = join(tempDir, `test-${mode}.yaml`);
      writeFileSync(piecePath, pieceYaml);

      const result = getPieceDescription(piecePath, tempDir);

      expect(result.interactiveMode).toBe(mode);
    }
  });
});

describe('getPieceDescription firstMovement field', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-first-movement-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return firstMovement with inline persona content', () => {
    const pieceYaml = `name: test-first
initial_movement: plan
max_movements: 1

movements:
  - name: plan
    persona: You are a planner.
    persona_name: Planner
    instruction: "Plan the task"
    allowed_tools:
      - Read
      - Glob
`;

    const piecePath = join(tempDir, 'test-first.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir);

    expect(result.firstMovement).toBeDefined();
    expect(result.firstMovement!.personaContent).toBe('You are a planner.');
    expect(result.firstMovement!.personaDisplayName).toBe('Planner');
    expect(result.firstMovement!.allowedTools).toEqual(['Read', 'Glob']);
  });

  it('should return firstMovement with persona file content', () => {
    const personaContent = '# Expert Planner\nYou plan tasks with precision.';
    const personaPath = join(tempDir, 'planner-persona.md');
    writeFileSync(personaPath, personaContent);

    const pieceYaml = `name: test-persona-file
initial_movement: plan
max_movements: 1

personas:
  planner: ./planner-persona.md

movements:
  - name: plan
    persona: planner
    persona_name: Planner
    instruction: "Plan the task"
`;

    const piecePath = join(tempDir, 'test-persona-file.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir);

    expect(result.firstMovement).toBeDefined();
    expect(result.firstMovement!.personaContent).toBe(personaContent);
  });

  it('should return undefined firstMovement when initialMovement not found', () => {
    const pieceYaml = `name: test-missing
initial_movement: nonexistent
max_movements: 1

movements:
  - name: step1
    persona: agent
    instruction: "Do something"
`;

    const piecePath = join(tempDir, 'test-missing.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir);

    expect(result.firstMovement).toBeUndefined();
  });

  it('should return empty allowedTools array when movement has no tools', () => {
    const pieceYaml = `name: test-no-tools
initial_movement: step1
max_movements: 1

movements:
  - name: step1
    persona: agent
    persona_name: Agent
    instruction: "Do something"
`;

    const piecePath = join(tempDir, 'test-no-tools.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir);

    expect(result.firstMovement).toBeDefined();
    expect(result.firstMovement!.allowedTools).toEqual([]);
  });

  it('should fallback to inline persona when personaPath is unreadable', () => {
    const personaPath = join(tempDir, 'unreadable.md');
    writeFileSync(personaPath, '# Persona');
    chmodSync(personaPath, 0o000);

    const pieceYaml = `name: test-fallback
initial_movement: step1
max_movements: 1

personas:
  myagent: ./unreadable.md

movements:
  - name: step1
    persona: myagent
    persona_name: Agent
    instruction: "Do something"
`;

    const piecePath = join(tempDir, 'test-fallback.yaml');
    writeFileSync(piecePath, pieceYaml);

    try {
      const result = getPieceDescription(piecePath, tempDir);

      expect(result.firstMovement).toBeDefined();
      // personaPath is unreadable, so fallback to empty (persona was resolved to a path)
      expect(result.firstMovement!.personaContent).toBe('');
    } finally {
      chmodSync(personaPath, 0o644);
    }
  });
});
