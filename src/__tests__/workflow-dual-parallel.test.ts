/**
 * Tests for dual/dual-cqrs workflow parallel review structure.
 *
 * Validates that:
 * - dual and dual-cqrs workflows load successfully via loadWorkflow
 * - dual has 2-stage review: reviewers_1 (arch, frontend, testing) → reviewers_2 (security, qa, requirements)
 * - dual-cqrs has single-stage reviewers (cqrs-es, frontend, security, qa)
 * - ai_review routes to reviewers_1 (dual) / reviewers (dual-cqrs)
 * - fix step routes back to reviewers_1 (dual) / reviewers (dual-cqrs)
 * - Aggregate rules (all/any) are configured on reviewer steps
 * - Sub-step rules use simple approved/needs_fix conditions
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

import { loadWorkflow } from '../infra/config/index.js';

describe('dual workflow parallel structure', () => {
  const workflow = loadWorkflow('dual', process.cwd());

  it('should load successfully', () => {
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('dual');
  });

  it('should have reviewers_1 parallel step with 3 sub-steps', () => {
    const reviewers1 = workflow!.steps.find((s) => s.name === 'reviewers_1');
    expect(reviewers1).toBeDefined();
    expect(reviewers1!.parallel).toBeDefined();
    expect(reviewers1!.parallel!.length).toBe(3);
  });

  it('should have arch-review, frontend-review, testing-review in reviewers_1', () => {
    const reviewers1 = workflow!.steps.find((s) => s.name === 'reviewers_1');
    const subNames = reviewers1!.parallel!.map((s) => s.name);
    expect(subNames).toContain('arch-review');
    expect(subNames).toContain('frontend-review');
    expect(subNames).toContain('testing-review');
  });

  it('should have reviewers_2 parallel step with 3 sub-steps', () => {
    const reviewers2 = workflow!.steps.find((s) => s.name === 'reviewers_2');
    expect(reviewers2).toBeDefined();
    expect(reviewers2!.parallel).toBeDefined();
    expect(reviewers2!.parallel!.length).toBe(3);
  });

  it('should have security-review, qa-review, requirements-review in reviewers_2', () => {
    const reviewers2 = workflow!.steps.find((s) => s.name === 'reviewers_2');
    const subNames = reviewers2!.parallel!.map((s) => s.name);
    expect(subNames).toContain('security-review');
    expect(subNames).toContain('qa-review');
    expect(subNames).toContain('requirements-review');
  });

  it('should have aggregate rules on both reviewer steps', () => {
    for (const name of ['reviewers_1', 'reviewers_2']) {
      const reviewers = workflow!.steps.find((s) => s.name === name);
      expect(reviewers!.rules).toBeDefined();
      const conditions = reviewers!.rules!.map((r) => r.condition);
      expect(conditions).toContain('all("approved")');
      expect(conditions).toContain('any("needs_fix")');
    }
  });

  it('should have simple approved/needs_fix rules on each sub-step', () => {
    for (const name of ['reviewers_1', 'reviewers_2']) {
      const reviewers = workflow!.steps.find((s) => s.name === name);
      for (const sub of reviewers!.parallel!) {
        expect(sub.rules).toBeDefined();
        const conditions = sub.rules!.map((r) => r.condition);
        expect(conditions).toContain('approved');
        expect(conditions).toContain('needs_fix');
      }
    }
  });

  it('should route reviewers_1 all("approved") to reviewers_2', () => {
    const reviewers1 = workflow!.steps.find((s) => s.name === 'reviewers_1');
    const approvedRule = reviewers1!.rules!.find((r) => r.condition === 'all("approved")');
    expect(approvedRule!.next).toBe('reviewers_2');
  });

  it('should route reviewers_2 all("approved") to supervise', () => {
    const reviewers2 = workflow!.steps.find((s) => s.name === 'reviewers_2');
    const approvedRule = reviewers2!.rules!.find((r) => r.condition === 'all("approved")');
    expect(approvedRule!.next).toBe('supervise');
  });

  it('should route both reviewer stages any("needs_fix") to fix', () => {
    for (const name of ['reviewers_1', 'reviewers_2']) {
      const reviewers = workflow!.steps.find((s) => s.name === name);
      const needsFixRule = reviewers!.rules!.find((r) => r.condition === 'any("needs_fix")');
      expect(needsFixRule!.next).toBe('fix');
    }
  });

  it('should route ai_review to reviewers_1', () => {
    const aiReview = workflow!.steps.find((s) => s.name === 'ai_review');
    expect(aiReview).toBeDefined();
    const approvedRule = aiReview!.rules!.find((r) => r.next === 'reviewers_1');
    expect(approvedRule).toBeDefined();
  });

  it('should have fix step routing back to reviewers_1', () => {
    const fix = workflow!.steps.find((s) => s.name === 'fix');
    expect(fix).toBeDefined();
    const fixComplete = fix!.rules!.find((r) => r.next === 'reviewers_1');
    expect(fixComplete).toBeDefined();
  });

  it('should not have individual review/fix steps', () => {
    const stepNames = workflow!.steps.map((s) => s.name);
    expect(stepNames).not.toContain('architect_review');
    expect(stepNames).not.toContain('fix_architect');
    expect(stepNames).not.toContain('frontend_review');
    expect(stepNames).not.toContain('fix_frontend');
    expect(stepNames).not.toContain('security_review');
    expect(stepNames).not.toContain('fix_security');
    expect(stepNames).not.toContain('qa_review');
    expect(stepNames).not.toContain('fix_qa');
  });

  it('should have write_tests step before implement', () => {
    const writeTests = workflow!.steps.find((s) => s.name === 'write_tests');
    expect(writeTests).toBeDefined();
    expect(writeTests!.edit).toBe(true);
  });

  it('should have team_leader on implement step', () => {
    const implement = workflow!.steps.find((s) => s.name === 'implement');
    expect(implement).toBeDefined();
    expect(implement!.teamLeader).toBeDefined();
    expect(implement!.teamLeader!.maxParts).toBe(2);
  });

  it('should not have fix_supervisor step', () => {
    const stepNames = workflow!.steps.map((s) => s.name);
    expect(stepNames).not.toContain('fix_supervisor');
  });
});

describe('dual-cqrs workflow parallel structure', () => {
  const workflow = loadWorkflow('dual-cqrs', process.cwd());

  it('should load successfully', () => {
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('dual-cqrs');
  });

  it('should have a reviewers parallel step', () => {
    const reviewers = workflow!.steps.find((s) => s.name === 'reviewers');
    expect(reviewers).toBeDefined();
    expect(reviewers!.parallel).toBeDefined();
    expect(reviewers!.parallel!.length).toBe(4);
  });

  it('should have cqrs-es-review instead of arch-review', () => {
    const reviewers = workflow!.steps.find((s) => s.name === 'reviewers');
    const subNames = reviewers!.parallel!.map((s) => s.name);
    expect(subNames).toContain('cqrs-es-review');
    expect(subNames).not.toContain('arch-review');
    expect(subNames).toContain('frontend-review');
    expect(subNames).toContain('security-review');
    expect(subNames).toContain('qa-review');
  });

  it('should have aggregate rules on reviewers step', () => {
    const reviewers = workflow!.steps.find((s) => s.name === 'reviewers');
    expect(reviewers!.rules).toBeDefined();
    const conditions = reviewers!.rules!.map((r) => r.condition);
    expect(conditions).toContain('all("approved")');
    expect(conditions).toContain('any("needs_fix")');
  });

  it('should have simple approved/needs_fix rules on each sub-step', () => {
    const reviewers = workflow!.steps.find((s) => s.name === 'reviewers');
    for (const sub of reviewers!.parallel!) {
      expect(sub.rules).toBeDefined();
      const conditions = sub.rules!.map((r) => r.condition);
      expect(conditions).toContain('approved');
      expect(conditions).toContain('needs_fix');
    }
  });

  it('should route ai_review to reviewers', () => {
    const aiReview = workflow!.steps.find((s) => s.name === 'ai_review');
    expect(aiReview).toBeDefined();
    const approvedRule = aiReview!.rules!.find((r) => r.next === 'reviewers');
    expect(approvedRule).toBeDefined();
  });

  it('should have a unified fix step routing back to reviewers', () => {
    const fix = workflow!.steps.find((s) => s.name === 'fix');
    expect(fix).toBeDefined();
    const fixComplete = fix!.rules!.find((r) => r.next === 'reviewers');
    expect(fixComplete).toBeDefined();
  });

  it('should not have individual review/fix steps', () => {
    const stepNames = workflow!.steps.map((s) => s.name);
    expect(stepNames).not.toContain('cqrs_es_review');
    expect(stepNames).not.toContain('fix_cqrs_es');
    expect(stepNames).not.toContain('frontend_review');
    expect(stepNames).not.toContain('fix_frontend');
    expect(stepNames).not.toContain('security_review');
    expect(stepNames).not.toContain('fix_security');
    expect(stepNames).not.toContain('qa_review');
    expect(stepNames).not.toContain('fix_qa');
  });

  it('should use cqrs-es-reviewer agent for the first sub-step', () => {
    const reviewers = workflow!.steps.find((s) => s.name === 'reviewers');
    const cqrsReview = reviewers!.parallel!.find((s) => s.name === 'cqrs-es-review');
    expect(cqrsReview!.persona).toContain('cqrs-es-reviewer');
  });
});
