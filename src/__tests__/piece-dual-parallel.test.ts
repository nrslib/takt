/**
 * Tests for dual/dual-cqrs piece parallel review structure.
 *
 * Validates that:
 * - dual and dual-cqrs pieces load successfully via loadPiece
 * - The reviewers movement is a parallel movement with expected sub-movements
 * - ai_review routes to reviewers (not individual review movements)
 * - fix movement routes back to reviewers
 * - Aggregate rules (all/any) are configured on the reviewers movement
 * - Sub-movement rules use simple approved/needs_fix conditions
 */

import { describe, it, expect } from 'vitest';
import { loadPiece } from '../infra/config/index.js';

describe('dual piece parallel structure', () => {
  const piece = loadPiece('dual', process.cwd());

  it('should load successfully', () => {
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('dual');
  });

  it('should have a reviewers parallel movement', () => {
    const reviewers = piece!.movements.find((s) => s.name === 'reviewers');
    expect(reviewers).toBeDefined();
    expect(reviewers!.parallel).toBeDefined();
    expect(reviewers!.parallel!.length).toBe(4);
  });

  it('should have arch-review, frontend-review, security-review, qa-review as sub-movements', () => {
    const reviewers = piece!.movements.find((s) => s.name === 'reviewers');
    const subNames = reviewers!.parallel!.map((s) => s.name);
    expect(subNames).toContain('arch-review');
    expect(subNames).toContain('frontend-review');
    expect(subNames).toContain('security-review');
    expect(subNames).toContain('qa-review');
  });

  it('should have aggregate rules on reviewers movement', () => {
    const reviewers = piece!.movements.find((s) => s.name === 'reviewers');
    expect(reviewers!.rules).toBeDefined();
    const conditions = reviewers!.rules!.map((r) => r.condition);
    expect(conditions).toContain('all("approved")');
    expect(conditions).toContain('any("needs_fix")');
  });

  it('should have simple approved/needs_fix rules on each sub-movement', () => {
    const reviewers = piece!.movements.find((s) => s.name === 'reviewers');
    for (const sub of reviewers!.parallel!) {
      expect(sub.rules).toBeDefined();
      const conditions = sub.rules!.map((r) => r.condition);
      expect(conditions).toContain('approved');
      expect(conditions).toContain('needs_fix');
    }
  });

  it('should route ai_review to reviewers', () => {
    const aiReview = piece!.movements.find((s) => s.name === 'ai_review');
    expect(aiReview).toBeDefined();
    const approvedRule = aiReview!.rules!.find((r) => r.next === 'reviewers');
    expect(approvedRule).toBeDefined();
  });

  it('should have a unified fix movement routing back to reviewers', () => {
    const fix = piece!.movements.find((s) => s.name === 'fix');
    expect(fix).toBeDefined();
    const fixComplete = fix!.rules!.find((r) => r.next === 'reviewers');
    expect(fixComplete).toBeDefined();
  });

  it('should not have individual review/fix movements', () => {
    const movementNames = piece!.movements.map((s) => s.name);
    expect(movementNames).not.toContain('architect_review');
    expect(movementNames).not.toContain('fix_architect');
    expect(movementNames).not.toContain('frontend_review');
    expect(movementNames).not.toContain('fix_frontend');
    expect(movementNames).not.toContain('security_review');
    expect(movementNames).not.toContain('fix_security');
    expect(movementNames).not.toContain('qa_review');
    expect(movementNames).not.toContain('fix_qa');
  });

  it('should route reviewers all("approved") to supervise', () => {
    const reviewers = piece!.movements.find((s) => s.name === 'reviewers');
    const approvedRule = reviewers!.rules!.find((r) => r.condition === 'all("approved")');
    expect(approvedRule!.next).toBe('supervise');
  });

  it('should route reviewers any("needs_fix") to fix', () => {
    const reviewers = piece!.movements.find((s) => s.name === 'reviewers');
    const needsFixRule = reviewers!.rules!.find((r) => r.condition === 'any("needs_fix")');
    expect(needsFixRule!.next).toBe('fix');
  });
});

describe('dual-cqrs piece parallel structure', () => {
  const piece = loadPiece('dual-cqrs', process.cwd());

  it('should load successfully', () => {
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('dual-cqrs');
  });

  it('should have a reviewers parallel movement', () => {
    const reviewers = piece!.movements.find((s) => s.name === 'reviewers');
    expect(reviewers).toBeDefined();
    expect(reviewers!.parallel).toBeDefined();
    expect(reviewers!.parallel!.length).toBe(4);
  });

  it('should have cqrs-es-review instead of arch-review', () => {
    const reviewers = piece!.movements.find((s) => s.name === 'reviewers');
    const subNames = reviewers!.parallel!.map((s) => s.name);
    expect(subNames).toContain('cqrs-es-review');
    expect(subNames).not.toContain('arch-review');
    expect(subNames).toContain('frontend-review');
    expect(subNames).toContain('security-review');
    expect(subNames).toContain('qa-review');
  });

  it('should have aggregate rules on reviewers movement', () => {
    const reviewers = piece!.movements.find((s) => s.name === 'reviewers');
    expect(reviewers!.rules).toBeDefined();
    const conditions = reviewers!.rules!.map((r) => r.condition);
    expect(conditions).toContain('all("approved")');
    expect(conditions).toContain('any("needs_fix")');
  });

  it('should have simple approved/needs_fix rules on each sub-movement', () => {
    const reviewers = piece!.movements.find((s) => s.name === 'reviewers');
    for (const sub of reviewers!.parallel!) {
      expect(sub.rules).toBeDefined();
      const conditions = sub.rules!.map((r) => r.condition);
      expect(conditions).toContain('approved');
      expect(conditions).toContain('needs_fix');
    }
  });

  it('should route ai_review to reviewers', () => {
    const aiReview = piece!.movements.find((s) => s.name === 'ai_review');
    expect(aiReview).toBeDefined();
    const approvedRule = aiReview!.rules!.find((r) => r.next === 'reviewers');
    expect(approvedRule).toBeDefined();
  });

  it('should have a unified fix movement routing back to reviewers', () => {
    const fix = piece!.movements.find((s) => s.name === 'fix');
    expect(fix).toBeDefined();
    const fixComplete = fix!.rules!.find((r) => r.next === 'reviewers');
    expect(fixComplete).toBeDefined();
  });

  it('should not have individual review/fix movements', () => {
    const movementNames = piece!.movements.map((s) => s.name);
    expect(movementNames).not.toContain('cqrs_es_review');
    expect(movementNames).not.toContain('fix_cqrs_es');
    expect(movementNames).not.toContain('frontend_review');
    expect(movementNames).not.toContain('fix_frontend');
    expect(movementNames).not.toContain('security_review');
    expect(movementNames).not.toContain('fix_security');
    expect(movementNames).not.toContain('qa_review');
    expect(movementNames).not.toContain('fix_qa');
  });

  it('should use cqrs-es-reviewer agent for the first sub-movement', () => {
    const reviewers = piece!.movements.find((s) => s.name === 'reviewers');
    const cqrsReview = reviewers!.parallel!.find((s) => s.name === 'cqrs-es-review');
    expect(cqrsReview!.persona).toContain('cqrs-es-reviewer');
  });
});
