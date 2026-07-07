import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildSessionKey } from '../core/workflow/session-key.js';
import type { WorkflowStep } from '../core/models/types.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';

function createStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'test-step',
    personaDisplayName: 'test',
    edit: false,
    instruction: '',
    passPreviousResponse: true,
    ...overrides,
  };
}

describe('buildSessionKey', () => {
  it('should use persona as base key when persona is set', () => {
    const step = createStep({ persona: 'coder', name: 'implement' });
    expect(buildSessionKey(step)).toBe('coder');
  });

  it('should use explicit session key before persona when session key is set', () => {
    const step = createStep({ sessionKey: 'worker-1', persona: 'coder', provider: 'claude' });
    expect(buildSessionKey(step)).toBe('worker-1:claude');
  });

  it('should use name as base key when persona is not set', () => {
    const step = createStep({ persona: undefined, name: 'plan' });
    expect(buildSessionKey(step)).toBe('plan');
  });

  it('should append provider when provider is specified', () => {
    const step = createStep({ persona: 'coder', provider: 'claude' });
    expect(buildSessionKey(step)).toBe('coder:claude');
  });

  it('should use name with provider when persona is not set', () => {
    const step = createStep({ persona: undefined, name: 'review', provider: 'codex' });
    expect(buildSessionKey(step)).toBe('review:codex');
  });

  it('should produce different keys for same persona with different providers', () => {
    const claudeStep = createStep({ persona: 'coder', provider: 'claude', name: 'claude-eye' });
    const codexStep = createStep({ persona: 'coder', provider: 'codex', name: 'codex-eye' });
    expect(buildSessionKey(claudeStep)).not.toBe(buildSessionKey(codexStep));
    expect(buildSessionKey(claudeStep)).toBe('coder:claude');
    expect(buildSessionKey(codexStep)).toBe('coder:codex');
  });

  it('should separate claude-sdk from headless claude in session key', () => {
    const sdkStep = createStep({
      persona: 'coder',
      name: 'sdk-eye',
      provider: 'claude-sdk',
    });
    const headlessStep = createStep({ persona: 'coder', provider: 'claude', name: 'cli-eye' });

    expect(buildSessionKey(sdkStep)).toBe('coder:claude-sdk');
    expect(buildSessionKey(headlessStep)).toBe('coder:claude');
    expect(buildSessionKey(sdkStep)).not.toBe(buildSessionKey(headlessStep));
  });

  it('should not append provider when provider is undefined', () => {
    const step = createStep({ persona: 'coder', provider: undefined });
    expect(buildSessionKey(step)).toBe('coder');
  });

  it('should prefer runtime provider override over step provider', () => {
    const step = createStep({ persona: 'coder', provider: 'opencode' });
    expect(buildSessionKey(step, 'codex')).toBe('coder:codex');
  });

  it('should use explicit session key as-is (Zod trims at parse time)', () => {
    const step = createStep({ sessionKey: 'shared reviewer', persona: 'coder', provider: 'claude' });
    expect(buildSessionKey(step)).toBe('shared reviewer:claude');
  });

  it('should normalize session_key from top-level and parallel workflow YAML', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-session-key-loader-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-session-key-global-'));
    const originalConfigDir = process.env.TAKT_CONFIG_DIR;
    const workflowPath = join(projectDir, '.takt', 'workflows', 'session-key.yaml');
    try {
      process.env.TAKT_CONFIG_DIR = globalConfigDir;
      mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
      writeFileSync(workflowPath, [
        'name: session-key-test',
        'initial_step: agent-step',
        'max_steps: 5',
        'loop_monitors:',
        '  - cycle:',
        '      - agent-step',
        '      - system-step',
        '    threshold: 2',
        '    judge:',
        '      session_key: loop-monitor-session',
        '      persona: coder',
        '      rules:',
        '        - condition: Healthy',
        '          next: agent-step',
        'steps:',
        '  - name: agent-step',
        '    session_key: shared-agent',
        '    persona: coder',
        '    instruction: Do work',
        '    provider: claude',
        '    rules:',
        '      - condition: done',
        '        next: system-step',
        '  - name: system-step',
        '    kind: system',
        '    rules:',
        '      - condition: done',
        '        next: delegate',
        '  - name: delegate',
        '    kind: workflow_call',
        '    call: child',
        '    rules:',
        '      - condition: COMPLETE',
        '        next: parallel-step',
        '  - name: parallel-step',
        '    parallel:',
        '      - name: worker',
        '        session_key: worker-session',
        '        persona: coder',
        '        instruction: Do worker work',
        '        provider: codex',
        '        rules:',
        '          - condition: done',
        '    rules:',
        '      - condition: all("done")',
        '        next: COMPLETE',
      ].join('\n'));

      const workflow = loadWorkflowFromFile(workflowPath, projectDir);
      const agentStep = workflow.steps.find((step) => step.name === 'agent-step');
      const parallelStep = workflow.steps.find((step) => step.name === 'parallel-step');
      const workerStep = parallelStep?.parallel?.[0];
      const loopMonitor = workflow.loopMonitors?.[0];

      expect(agentStep?.sessionKey).toBe('shared-agent');
      expect(workerStep?.sessionKey).toBe('worker-session');
      expect(loopMonitor?.judge.sessionKey).toBe('loop-monitor-session');
      expect(agentStep ? buildSessionKey(agentStep) : undefined).toBe('shared-agent:claude');
      expect(workerStep ? buildSessionKey(workerStep) : undefined).toBe('worker-session:codex');
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.TAKT_CONFIG_DIR;
      } else {
        process.env.TAKT_CONFIG_DIR = originalConfigDir;
      }
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('should reject session_key on non-agent and parallel parent workflow entries', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-session-key-inert-'));
    const cases = [
      {
        name: 'system',
        lines: [
          'name: inert-system-session-key-test',
          'initial_step: system-step',
          'steps:',
          '  - name: system-step',
          '    kind: system',
          '    session_key: system-session',
          '    rules:',
          '      - condition: done',
          '        next: COMPLETE',
        ],
      },
      {
        name: 'workflow-call',
        lines: [
          'name: inert-workflow-call-session-key-test',
          'initial_step: delegate',
          'steps:',
          '  - name: delegate',
          '    kind: workflow_call',
          '    session_key: delegate-session',
          '    call: child',
          '    rules:',
          '      - condition: COMPLETE',
          '        next: COMPLETE',
        ],
      },
      {
        name: 'parallel-parent',
        lines: [
          'name: inert-parallel-parent-session-key-test',
          'initial_step: parallel-step',
          'steps:',
          '  - name: parallel-step',
          '    session_key: parent-session',
          '    parallel:',
          '      - name: worker',
          '        persona: coder',
          '        instruction: Do worker work',
          '        rules:',
          '          - condition: done',
          '    rules:',
          '      - condition: all("done")',
          '        next: COMPLETE',
        ],
      },
    ];
    try {
      mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
      for (const testCase of cases) {
        const workflowPath = join(projectDir, '.takt', 'workflows', `${testCase.name}.yaml`);
        writeFileSync(workflowPath, testCase.lines.join('\n'));
        expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/session_key/);
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('should reject empty session_key in workflow YAML', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-session-key-empty-'));
    const workflowPath = join(projectDir, '.takt', 'workflows', 'empty-session-key.yaml');
    try {
      mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
      writeFileSync(workflowPath, [
        'name: empty-session-key-test',
        'initial_step: agent-step',
        'steps:',
        '  - name: agent-step',
        '    session_key: ""',
        '    persona: coder',
        '    instruction: Do work',
        '    rules:',
        '      - condition: done',
        '        next: COMPLETE',
      ].join('\n'));

      expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/session_key/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('should reject whitespace-only session_key in workflow YAML', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-session-key-whitespace-'));
    const cases = [
      {
        name: 'top-level',
        lines: [
          'name: whitespace-session-key-test',
          'initial_step: agent-step',
          'steps:',
          '  - name: agent-step',
          '    session_key: "   "',
          '    persona: coder',
          '    instruction: Do work',
          '    rules:',
          '      - condition: done',
          '        next: COMPLETE',
        ],
      },
      {
        name: 'parallel',
        lines: [
          'name: whitespace-parallel-session-key-test',
          'initial_step: parallel-step',
          'steps:',
          '  - name: parallel-step',
          '    parallel:',
          '      - name: worker',
          '        session_key: "   "',
          '        persona: coder',
          '        instruction: Do worker work',
          '        rules:',
          '          - condition: done',
          '    rules:',
          '      - condition: all("done")',
          '        next: COMPLETE',
        ],
      },
      {
        name: 'loop-monitor',
        lines: [
          'name: whitespace-loop-monitor-session-key-test',
          'initial_step: agent-step',
          'loop_monitors:',
          '  - cycle:',
          '      - agent-step',
          '      - agent-step',
          '    judge:',
          '      session_key: "   "',
          '      rules:',
          '        - condition: Healthy',
          '          next: agent-step',
          'steps:',
          '  - name: agent-step',
          '    persona: coder',
          '    instruction: Do work',
          '    rules:',
          '      - condition: done',
          '        next: COMPLETE',
        ],
      },
    ];
    try {
      mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
      for (const testCase of cases) {
        const workflowPath = join(projectDir, '.takt', 'workflows', `${testCase.name}.yaml`);
        writeFileSync(workflowPath, testCase.lines.join('\n'));
        expect(() => loadWorkflowFromFile(workflowPath, projectDir)).toThrow(/session_key/);
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
