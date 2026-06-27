/**
 * Tests for knowledge category feature
 *
 * Covers:
 * - Schema validation for knowledge field at workflow and step level
 * - Workflow parser resolution of knowledge references
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WorkflowConfigRawSchema,
  WorkflowStepRawSchema,
  ParallelSubStepRawSchema,
} from '../core/models/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

describe('WorkflowConfigRawSchema knowledge field', () => {
  it('should accept knowledge map at workflow level', () => {
    const raw = {
      name: 'test-workflow',
      knowledge: {
        frontend: 'frontend.md',
        backend: 'backend.md',
      },
      steps: [
        { name: 'step1', persona: 'coder.md', instruction: '{task}' },
      ],
    };

    const result = WorkflowConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge).toEqual({
        frontend: 'frontend.md',
        backend: 'backend.md',
      });
    }
  });

  it('should accept workflow without knowledge field', () => {
    const raw = {
      name: 'test-workflow',
      steps: [
        { name: 'step1', persona: 'coder.md', instruction: '{task}' },
      ],
    };

    const result = WorkflowConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge).toBeUndefined();
    }
  });
});

describe('WorkflowStepRawSchema knowledge field', () => {
  it('should accept knowledge as a string reference', () => {
    const raw = {
      name: 'implement',
      persona: 'coder.md',
      knowledge: 'frontend',
      instruction: '{task}',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
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

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge).toEqual(['frontend', 'backend']);
    }
  });

  it('should accept step without knowledge field', () => {
    const raw = {
      name: 'implement',
      persona: 'coder.md',
      instruction: '{task}',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
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

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.policy).toBe('coding');
      expect(result.data.knowledge).toBe('frontend');
    }
  });
});

describe('ParallelSubStepRawSchema knowledge field', () => {
  it('should accept knowledge on parallel sub-steps', () => {
    const raw = {
      name: 'sub-step',
      persona: 'reviewer.md',
      knowledge: 'security',
      instruction: 'Review security',
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge).toBe('security');
    }
  });

  it('should accept knowledge array on parallel sub-steps', () => {
    const raw = {
      name: 'sub-step',
      persona: 'reviewer.md',
      knowledge: ['security', 'performance'],
      instruction: 'Review',
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge).toEqual(['security', 'performance']);
    }
  });
});

describe('normalizeWorkflowConfig knowledge resolution', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-knowledge-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should resolve knowledge from workflow-level map to step', () => {
    const frontendKnowledge = '# Frontend Knowledge\n\nUse React for components.';
    writeFileSync(join(tempDir, 'frontend.md'), frontendKnowledge);

    const raw = {
      name: 'test-workflow',
      knowledge: {
        frontend: 'frontend.md',
      },
      steps: [
        {
          name: 'implement',
          persona: 'coder.md',
          knowledge: 'frontend',
          instruction: '{task}',
        },
      ],
    };

    const workflow = normalizeWorkflowConfig(raw, tempDir);

    expect(workflow.knowledge).toBeDefined();
    expect(workflow.knowledge!['frontend']).toBe(frontendKnowledge);
    expect(workflow.steps[0].knowledgeContents).toEqual([frontendKnowledge]);
  });

  it('should resolve multiple knowledge references', () => {
    const frontendKnowledge = '# Frontend\nReact patterns.';
    const backendKnowledge = '# Backend\nAPI design.';
    writeFileSync(join(tempDir, 'frontend.md'), frontendKnowledge);
    writeFileSync(join(tempDir, 'backend.md'), backendKnowledge);

    const raw = {
      name: 'test-workflow',
      knowledge: {
        frontend: 'frontend.md',
        backend: 'backend.md',
      },
      steps: [
        {
          name: 'implement',
          persona: 'coder.md',
          knowledge: ['frontend', 'backend'],
          instruction: '{task}',
        },
      ],
    };

    const workflow = normalizeWorkflowConfig(raw, tempDir);

    expect(workflow.steps[0].knowledgeContents).toHaveLength(2);
    expect(workflow.steps[0].knowledgeContents).toContain(frontendKnowledge);
    expect(workflow.steps[0].knowledgeContents).toContain(backendKnowledge);
  });

  it('should resolve knowledge on parallel sub-steps', () => {
    const securityKnowledge = '# Security\nOWASP guidelines.';
    writeFileSync(join(tempDir, 'security.md'), securityKnowledge);

    const raw = {
      name: 'test-workflow',
      knowledge: {
        security: 'security.md',
      },
      steps: [
        {
          name: 'review',
          parallel: [
            {
              name: 'sec-review',
              persona: 'reviewer.md',
              knowledge: 'security',
              instruction: 'Review security',
            },
          ],
          rules: [{ condition: 'approved', next: 'COMPLETE' }],
        },
      ],
    };

    const workflow = normalizeWorkflowConfig(raw, tempDir);

    expect(workflow.steps[0].parallel).toHaveLength(1);
    expect(workflow.steps[0].parallel![0].knowledgeContents).toEqual([securityKnowledge]);
  });

  it('should handle inline knowledge content', () => {
    const raw = {
      name: 'test-workflow',
      knowledge: {
        inline: 'This is inline knowledge content.',
      },
      steps: [
        {
          name: 'implement',
          persona: 'coder.md',
          knowledge: 'inline',
          instruction: '{task}',
        },
      ],
    };

    const workflow = normalizeWorkflowConfig(raw, tempDir);

    expect(workflow.knowledge!['inline']).toBe('This is inline knowledge content.');
    expect(workflow.steps[0].knowledgeContents).toEqual(['This is inline knowledge content.']);
  });

  it('should handle direct file path reference without workflow-level map', () => {
    const directKnowledge = '# Direct Knowledge\nLoaded directly.';
    writeFileSync(join(tempDir, 'direct.md'), directKnowledge);

    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'implement',
          persona: 'coder.md',
          knowledge: 'direct.md',
          instruction: '{task}',
        },
      ],
    };

    const workflow = normalizeWorkflowConfig(raw, tempDir);

    expect(workflow.steps[0].knowledgeContents).toEqual([directKnowledge]);
  });

  it('should treat non-file reference as inline content when knowledge reference not found in map', () => {
    const raw = {
      name: 'test-workflow',
      steps: [
        {
          name: 'implement',
          persona: 'coder.md',
          knowledge: 'nonexistent',
          instruction: '{task}',
        },
      ],
    };

    const workflow = normalizeWorkflowConfig(raw, tempDir);

    // Non-.md references that are not in the knowledge map are treated as inline content
    expect(workflow.steps[0].knowledgeContents).toEqual(['nonexistent']);
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

  it('should resolve both policy and knowledge for same step', () => {
    const policyContent = '# Coding Policy\nWrite clean code.';
    const knowledgeContent = '# Frontend Knowledge\nUse TypeScript.';
    writeFileSync(join(tempDir, 'coding.md'), policyContent);
    writeFileSync(join(tempDir, 'frontend.md'), knowledgeContent);

    const raw = {
      name: 'test-workflow',
      policies: {
        coding: 'coding.md',
      },
      knowledge: {
        frontend: 'frontend.md',
      },
      steps: [
        {
          name: 'implement',
          persona: 'coder.md',
          policy: 'coding',
          knowledge: 'frontend',
          instruction: '{task}',
        },
      ],
    };

    const workflow = normalizeWorkflowConfig(raw, tempDir);

    expect(workflow.policies!['coding']).toBe(policyContent);
    expect(workflow.knowledge!['frontend']).toBe(knowledgeContent);
    expect(workflow.steps[0].policyContents).toEqual([policyContent]);
    expect(workflow.steps[0].knowledgeContents).toEqual([knowledgeContent]);
  });
});
