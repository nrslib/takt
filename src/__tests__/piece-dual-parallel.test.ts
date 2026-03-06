/**
 * Tests for dual/dual-cqrs piece parallel review structure.
 *
 * Validates that:
 * - dual and dual-cqrs pieces load successfully via loadPiece
 * - dual has 2-stage review: reviewers_1 (arch, frontend, testing) → reviewers_2 (security, qa, requirements)
 * - dual-cqrs has single-stage reviewers (cqrs-es, frontend, security, qa)
 * - ai_review routes to reviewers_1 (dual) / reviewers (dual-cqrs)
 * - fix movement routes back to reviewers_1 (dual) / reviewers (dual-cqrs)
 * - Aggregate rules (all/any) are configured on reviewer movements
 * - Sub-movement rules use simple approved/needs_fix conditions
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    loadGlobalConfig: () => ({
      language: 'en',
      provider: 'claude',
      autoFetch: false,
    }),
  };
});

import { loadPiece } from '../infra/config/index.js';

describe('dual piece parallel structure', () => {
  const piece = loadPiece('dual', process.cwd());

  it('should load successfully', () => {
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('dual');
  });

  it('should have reviewers_1 parallel movement with 3 sub-movements', () => {
    const reviewers1 = piece!.movements.find((s) => s.name === 'reviewers_1');
    expect(reviewers1).toBeDefined();
    expect(reviewers1!.parallel).toBeDefined();
    expect(reviewers1!.parallel!.length).toBe(3);
  });

  it('should have arch-review, frontend-review, testing-review in reviewers_1', () => {
    const reviewers1 = piece!.movements.find((s) => s.name === 'reviewers_1');
    const subNames = reviewers1!.parallel!.map((s) => s.name);
    expect(subNames).toContain('arch-review');
    expect(subNames).toContain('frontend-review');
    expect(subNames).toContain('testing-review');
  });

  it('should have reviewers_2 parallel movement with 3 sub-movements', () => {
    const reviewers2 = piece!.movements.find((s) => s.name === 'reviewers_2');
    expect(reviewers2).toBeDefined();
    expect(reviewers2!.parallel).toBeDefined();
    expect(reviewers2!.parallel!.length).toBe(3);
  });

  it('should have security-review, qa-review, requirements-review in reviewers_2', () => {
    const reviewers2 = piece!.movements.find((s) => s.name === 'reviewers_2');
    const subNames = reviewers2!.parallel!.map((s) => s.name);
    expect(subNames).toContain('security-review');
    expect(subNames).toContain('qa-review');
    expect(subNames).toContain('requirements-review');
  });

  it('should have aggregate rules on both reviewer movements', () => {
    for (const name of ['reviewers_1', 'reviewers_2']) {
      const reviewers = piece!.movements.find((s) => s.name === name);
      expect(reviewers!.rules).toBeDefined();
      const conditions = reviewers!.rules!.map((r) => r.condition);
      expect(conditions).toContain('all("approved")');
      expect(conditions).toContain('any("needs_fix")');
    }
  });

  it('should have simple approved/needs_fix rules on each sub-movement', () => {
    for (const name of ['reviewers_1', 'reviewers_2']) {
      const reviewers = piece!.movements.find((s) => s.name === name);
      for (const sub of reviewers!.parallel!) {
        expect(sub.rules).toBeDefined();
        const conditions = sub.rules!.map((r) => r.condition);
        expect(conditions).toContain('approved');
        expect(conditions).toContain('needs_fix');
      }
    }
  });

  it('should route reviewers_1 all("approved") to reviewers_2', () => {
    const reviewers1 = piece!.movements.find((s) => s.name === 'reviewers_1');
    const approvedRule = reviewers1!.rules!.find((r) => r.condition === 'all("approved")');
    expect(approvedRule!.next).toBe('reviewers_2');
  });

  it('should route reviewers_2 all("approved") to supervise', () => {
    const reviewers2 = piece!.movements.find((s) => s.name === 'reviewers_2');
    const approvedRule = reviewers2!.rules!.find((r) => r.condition === 'all("approved")');
    expect(approvedRule!.next).toBe('supervise');
  });

  it('should route both reviewer stages any("needs_fix") to fix', () => {
    for (const name of ['reviewers_1', 'reviewers_2']) {
      const reviewers = piece!.movements.find((s) => s.name === name);
      const needsFixRule = reviewers!.rules!.find((r) => r.condition === 'any("needs_fix")');
      expect(needsFixRule!.next).toBe('fix');
    }
  });

  it('should route ai_review to reviewers_1', () => {
    const aiReview = piece!.movements.find((s) => s.name === 'ai_review');
    expect(aiReview).toBeDefined();
    const approvedRule = aiReview!.rules!.find((r) => r.next === 'reviewers_1');
    expect(approvedRule).toBeDefined();
  });

  it('should have fix movement routing back to reviewers_1', () => {
    const fix = piece!.movements.find((s) => s.name === 'fix');
    expect(fix).toBeDefined();
    const fixComplete = fix!.rules!.find((r) => r.next === 'reviewers_1');
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

  it('should have write_tests movement before implement', () => {
    const writeTests = piece!.movements.find((s) => s.name === 'write_tests');
    expect(writeTests).toBeDefined();
    expect(writeTests!.edit).toBe(true);
  });

  it('should have team_leader on implement movement', () => {
    const implement = piece!.movements.find((s) => s.name === 'implement');
    expect(implement).toBeDefined();
    expect(implement!.teamLeader).toBeDefined();
    expect(implement!.teamLeader!.maxParts).toBe(2);
  });

  it('should not have fix_supervisor movement', () => {
    const movementNames = piece!.movements.map((s) => s.name);
    expect(movementNames).not.toContain('fix_supervisor');
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
