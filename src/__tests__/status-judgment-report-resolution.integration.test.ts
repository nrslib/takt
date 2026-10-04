import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from '../core/models/types.js';
import { runStatusJudgmentPhase } from '../core/workflow/status-judgment-phase.js';
import { inheritResumeReportSnapshot } from '../core/workflow/run/resume-report-snapshot.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

describe('status judgment report resolution', () => {
  it('should resolve a use_judge report from the matching resume snapshot consumer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-status-judgment-'));
    try {
      const sourceReports = join(root, '.takt', 'runs', 'source-run', 'reports');
      const exactPath = 'subworkflows/old-final-gate/review-resolution.md';
      const consumerKey = '{"workflow":"review-gate","step":"final-gate","calls":[]}';
      mkdirSync(join(sourceReports, 'subworkflows', 'old-final-gate'), { recursive: true });
      writeFileSync(join(sourceReports, 'review-resolution.md'), 'WRONG ROOT REPORT');
      writeFileSync(join(sourceReports, ...exactPath.split('/')), 'EXACT SNAPSHOT REPORT');
      inheritResumeReportSnapshot({
        cwd: root,
        sourceRunSlug: 'source-run',
        targetRunSlug: 'target-run',
        resumeReportConsumers: [{
          consumerKey,
          reportDirectories: ['subworkflows/old-final-gate'],
          references: [{ reference: 'review-resolution.md', path: exactPath }],
        }],
      });
      const reportsRootDir = join(root, '.takt', 'runs', 'target-run', 'reports');
      const reportDir = join(reportsRootDir, 'subworkflows', 'new-final-gate');
      mkdirSync(reportDir, { recursive: true });
      const structuredCaller = {
        judgeStatus: vi.fn().mockImplementation(async (structured, tag, _candidates, options) => {
          expect(structured).toContain('EXACT SNAPSHOT REPORT');
          expect(tag).toContain('EXACT SNAPSHOT REPORT');
          expect(structured).not.toContain('WRONG ROOT REPORT');
          expect(tag).not.toContain('WRONG ROOT REPORT');
          options.onStructuredPromptResolved?.({
            systemPrompt: 'conductor-system',
            userInstruction: 'structured prompt',
          });
          return { candidateIndex: 0, method: 'structured_output' as const };
        }),
      };
      const step: WorkflowStep = {
        name: 'final-gate',
        persona: 'reviewer',
        personaDisplayName: 'reviewer',
        instruction: 'Review',
        outputContracts: [{ name: 'review-resolution.md', format: '# Review', useJudge: true }],
        rules: [
          normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
          normalizeRule({ condition: 'needs_fix', next: 'fix' }),
        ],
      };

      const result = await runStatusJudgmentPhase(step, {
        cwd: root,
        reportDir,
        reportsRootDir,
        resumeReportConsumerKey: consumerKey,
        iteration: 1,
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'cursor', model: undefined }),
        structuredCaller,
      });

      expect(result.label).toBe('approved');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
