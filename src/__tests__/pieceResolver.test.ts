/**
 * Tests for getPieceDescription and buildWorkflowString
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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
max_iterations: 3

movements:
  - name: plan
    description: タスク計画
    agent: planner
    instruction: "Plan the task"
  - name: implement
    description: 実装
    agent: coder
    instruction: "Implement"
  - name: review
    agent: reviewer
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
  });

  it('should return workflow structure with parallel movements', () => {
    const pieceYaml = `name: coding
description: Full coding workflow
initial_movement: plan
max_iterations: 10

movements:
  - name: plan
    description: タスク計画
    agent: planner
    instruction: "Plan"
  - name: reviewers
    description: 並列レビュー
    parallel:
      - name: ai_review
        agent: ai-reviewer
        instruction: "AI review"
      - name: arch_review
        agent: arch-reviewer
        instruction: "Architecture review"
  - name: fix
    description: 修正
    agent: coder
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
  });

  it('should handle movements without descriptions', () => {
    const pieceYaml = `name: minimal
initial_movement: step1
max_iterations: 1

movements:
  - name: step1
    agent: coder
    instruction: "Do step1"
  - name: step2
    agent: coder
    instruction: "Do step2"
`;

    const piecePath = join(tempDir, 'minimal.yaml');
    writeFileSync(piecePath, pieceYaml);

    const result = getPieceDescription(piecePath, tempDir);

    expect(result.name).toBe('minimal');
    expect(result.description).toBe('');
    expect(result.pieceStructure).toBe('1. step1\n2. step2');
  });

  it('should return empty strings when piece is not found', () => {
    const result = getPieceDescription('nonexistent', tempDir);

    expect(result.name).toBe('nonexistent');
    expect(result.description).toBe('');
    expect(result.pieceStructure).toBe('');
  });

  it('should handle parallel movements without descriptions', () => {
    const pieceYaml = `name: test-parallel
initial_movement: parent
max_iterations: 1

movements:
  - name: parent
    parallel:
      - name: child1
        agent: agent1
        instruction: "Do child1"
      - name: child2
        agent: agent2
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
  });
});
