/**
 * Tests for review piece
 *
 * Covers:
 * - Piece YAML files (EN/JA) load and pass schema validation
 * - Piece structure: gather -> reviewers (parallel 5) -> supervise -> COMPLETE
 * - All movements have edit: false
 * - All 5 reviewers have Bash in allowed_tools
 * - Routing rules for gather and reviewers
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PieceConfigRawSchema } from '../core/models/index.js';

const RESOURCES_DIR = join(import.meta.dirname, '../../builtins');

function loadReviewYaml(lang: 'en' | 'ja') {
  const filePath = join(RESOURCES_DIR, lang, 'pieces', 'review.yaml');
  const content = readFileSync(filePath, 'utf-8');
  return parseYaml(content);
}

describe('review piece (EN)', () => {
  const raw = loadReviewYaml('en');

  it('should pass schema validation', () => {
    const result = PieceConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should have correct name and initial_movement', () => {
    expect(raw.name).toBe('review');
    expect(raw.initial_movement).toBe('gather');
  });

  it('should have max_movements of 10', () => {
    expect(raw.max_movements).toBe(10);
  });

  it('should have 3 movements: gather, reviewers, supervise', () => {
    const movementNames = raw.movements.map((s: { name: string }) => s.name);
    expect(movementNames).toEqual(['gather', 'reviewers', 'supervise']);
  });

  it('should have all movements with edit: false', () => {
    for (const movement of raw.movements) {
      if (movement.edit !== undefined) {
        expect(movement.edit).toBe(false);
      }
      if (movement.parallel) {
        for (const sub of movement.parallel) {
          if (sub.edit !== undefined) {
            expect(sub.edit).toBe(false);
          }
        }
      }
    }
  });

  it('should have reviewers movement with 5 parallel sub-movements', () => {
    const reviewers = raw.movements.find((s: { name: string }) => s.name === 'reviewers');
    expect(reviewers).toBeDefined();
    expect(reviewers.parallel).toHaveLength(5);

    const subNames = reviewers.parallel.map((s: { name: string }) => s.name);
    expect(subNames).toEqual([
      'arch-review',
      'security-review',
      'qa-review',
      'testing-review',
      'requirements-review',
    ]);
  });

  it('should have reviewers movement with aggregate rules', () => {
    const reviewers = raw.movements.find((s: { name: string }) => s.name === 'reviewers');
    expect(reviewers.rules).toHaveLength(2);
    expect(reviewers.rules[0].condition).toBe('all("approved")');
    expect(reviewers.rules[0].next).toBe('supervise');
    expect(reviewers.rules[1].condition).toBe('any("needs_fix")');
    expect(reviewers.rules[1].next).toBe('supervise');
  });

  it('should have supervise movement with single rule to COMPLETE', () => {
    const supervise = raw.movements.find((s: { name: string }) => s.name === 'supervise');
    expect(supervise.rules).toHaveLength(1);
    expect(supervise.rules[0].condition).toBe('Review synthesis complete');
    expect(supervise.rules[0].next).toBe('COMPLETE');
  });

  it('should have gather movement using planner persona', () => {
    const gather = raw.movements.find((s: { name: string }) => s.name === 'gather');
    expect(gather.persona).toBe('planner');
  });

  it('should have supervise movement using supervisor persona', () => {
    const supervise = raw.movements.find((s: { name: string }) => s.name === 'supervise');
    expect(supervise.persona).toBe('supervisor');
  });

  it('should not have any movement with edit: true', () => {
    for (const movement of raw.movements) {
      expect(movement.edit).not.toBe(true);
      if (movement.parallel) {
        for (const sub of movement.parallel) {
          expect(sub.edit).not.toBe(true);
        }
      }
    }
  });

  it('should have Bash in allowed_tools for all 5 reviewers', () => {
    const reviewers = raw.movements.find((s: { name: string }) => s.name === 'reviewers');
    for (const sub of reviewers.parallel) {
      expect(sub.allowed_tools).toContain('Bash');
    }
  });

  it('should have gather movement with output_contracts for review target', () => {
    const gather = raw.movements.find((s: { name: string }) => s.name === 'gather');
    expect(gather.output_contracts).toBeDefined();
    expect(gather.output_contracts.report[0].name).toBe('review-target.md');
  });
});

describe('review piece (JA)', () => {
  const raw = loadReviewYaml('ja');

  it('should pass schema validation', () => {
    const result = PieceConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should have correct name and initial_movement', () => {
    expect(raw.name).toBe('review');
    expect(raw.initial_movement).toBe('gather');
  });

  it('should have same movement structure as EN version', () => {
    const movementNames = raw.movements.map((s: { name: string }) => s.name);
    expect(movementNames).toEqual(['gather', 'reviewers', 'supervise']);
  });

  it('should have reviewers movement with 5 parallel sub-movements', () => {
    const reviewers = raw.movements.find((s: { name: string }) => s.name === 'reviewers');
    expect(reviewers.parallel).toHaveLength(5);

    const subNames = reviewers.parallel.map((s: { name: string }) => s.name);
    expect(subNames).toEqual([
      'arch-review',
      'security-review',
      'qa-review',
      'testing-review',
      'requirements-review',
    ]);
  });

  it('should have all movements with edit: false or undefined', () => {
    for (const movement of raw.movements) {
      expect(movement.edit).not.toBe(true);
      if (movement.parallel) {
        for (const sub of movement.parallel) {
          expect(sub.edit).not.toBe(true);
        }
      }
    }
  });

  it('should have Bash in allowed_tools for all 5 reviewers', () => {
    const reviewers = raw.movements.find((s: { name: string }) => s.name === 'reviewers');
    for (const sub of reviewers.parallel) {
      expect(sub.allowed_tools).toContain('Bash');
    }
  });

  it('should have same aggregate rules on reviewers', () => {
    const reviewers = raw.movements.find((s: { name: string }) => s.name === 'reviewers');
    expect(reviewers.rules[0].condition).toBe('all("approved")');
    expect(reviewers.rules[1].condition).toBe('any("needs_fix")');
  });
});
