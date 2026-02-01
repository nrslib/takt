/**
 * Tests for expert/expert-cqrs workflow parallel review structure.
 *
 * Validates that:
 * - expert and expert-cqrs workflows load successfully via loadWorkflow
 * - The reviewers step is a parallel step with expected sub-steps
 * - ai_review routes to reviewers (not individual review steps)
 * - fix step routes back to reviewers
 * - Aggregate rules (all/any) are configured on the reviewers step
 * - Sub-step rules use simple approved/needs_fix conditions
 */

import { describe, it, expect } from 'vitest';
import { loadWorkflow } from '../config/loader.js';

describe('expert workflow parallel structure', () => {
  const workflow = loadWorkflow('expert', process.cwd());

  it('should load successfully', () => {
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('expert');
  });

  it('should have a reviewers parallel step', () => {
    const reviewers = workflow!.steps.find((s) => s.name === 'reviewers');
    expect(reviewers).toBeDefined();
    expect(reviewers!.parallel).toBeDefined();
    expect(reviewers!.parallel!.length).toBe(4);
  });

  it('should have arch-review, frontend-review, security-review, qa-review as sub-steps', () => {
    const reviewers = workflow!.steps.find((s) => s.name === 'reviewers');
    const subNames = reviewers!.parallel!.map((s) => s.name);
    expect(subNames).toContain('arch-review');
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
    expect(stepNames).not.toContain('architect_review');
    expect(stepNames).not.toContain('fix_architect');
    expect(stepNames).not.toContain('frontend_review');
    expect(stepNames).not.toContain('fix_frontend');
    expect(stepNames).not.toContain('security_review');
    expect(stepNames).not.toContain('fix_security');
    expect(stepNames).not.toContain('qa_review');
    expect(stepNames).not.toContain('fix_qa');
  });

  it('should route reviewers all("approved") to supervise', () => {
    const reviewers = workflow!.steps.find((s) => s.name === 'reviewers');
    const approvedRule = reviewers!.rules!.find((r) => r.condition === 'all("approved")');
    expect(approvedRule!.next).toBe('supervise');
  });

  it('should route reviewers any("needs_fix") to fix', () => {
    const reviewers = workflow!.steps.find((s) => s.name === 'reviewers');
    const needsFixRule = reviewers!.rules!.find((r) => r.condition === 'any("needs_fix")');
    expect(needsFixRule!.next).toBe('fix');
  });
});

describe('expert-cqrs workflow parallel structure', () => {
  const workflow = loadWorkflow('expert-cqrs', process.cwd());

  it('should load successfully', () => {
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('expert-cqrs');
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
    expect(cqrsReview!.agent).toContain('cqrs-es-reviewer');
  });
});
