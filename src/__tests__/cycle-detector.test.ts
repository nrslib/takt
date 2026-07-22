import { describe, expect, it } from 'vitest';
import type { LoopMonitorConfig } from '../core/models/index.js';
import { parseWorkflowRuleCondition } from '../core/models/workflow-rule-condition.js';
import { CycleDetector } from '../core/workflow/engine/cycle-detector.js';

function makeMonitor(cycle: string[], threshold: number): LoopMonitorConfig {
  return {
    cycle,
    threshold,
    judge: {
      rules: [
        { condition: parseWorkflowRuleCondition('progress'), next: cycle[0]! },
        { condition: parseWorkflowRuleCondition('stalled'), next: 'ABORT' },
      ],
    },
  };
}

function recordCycle(detector: CycleDetector, cycle: readonly string[], nextStep: string): ReturnType<CycleDetector['recordAndCheck']> {
  let result: ReturnType<CycleDetector['recordAndCheck']> = { triggered: false, cycleCount: 0 };
  for (const step of cycle) {
    result = detector.recordAndCheck(step, step === cycle.at(-1) ? nextStep : '__within_cycle__');
  }
  return result;
}

describe('CycleDetector', () => {
  it('triggers at the threshold only when the natural transition re-enters the cycle', () => {
    const monitor = makeMonitor(['reviewers', 'fix'], 3);
    const detector = new CycleDetector([monitor]);

    expect(recordCycle(detector, monitor.cycle, 'reviewers').triggered).toBe(false);
    expect(recordCycle(detector, monitor.cycle, 'reviewers').triggered).toBe(false);
    const result = recordCycle(detector, monitor.cycle, 'reviewers');

    expect(result).toEqual({ triggered: true, cycleCount: 3, monitor });
  });

  it('does not trigger when a completed cycle naturally exits to another step', () => {
    const monitor = makeMonitor(['fix', 'reviewers'], 2);
    const detector = new CycleDetector([monitor]);

    recordCycle(detector, monitor.cycle, 'fix');
    const result = recordCycle(detector, monitor.cycle, 'final-gate');

    expect(result.triggered).toBe(false);
    expect(detector.getHistory()).toEqual(['fix', 'reviewers', 'fix', 'reviewers']);
  });

  it('uses the proposed next step to select the monitor that would actually repeat', () => {
    const shortMonitor = makeMonitor(['fix', 'reviewers'], 2);
    const finalGateMonitor = makeMonitor(['fix', 'reviewers', 'final-gate'], 2);
    const detector = new CycleDetector([shortMonitor, finalGateMonitor]);

    recordCycle(detector, finalGateMonitor.cycle, 'fix');
    const result = recordCycle(detector, finalGateMonitor.cycle, 'fix');

    expect(result.triggered).toBe(true);
    expect(result.monitor).toBe(finalGateMonitor);
  });

  it('resets completed history after judge intervention', () => {
    const monitor = makeMonitor(['A', 'B'], 1);
    const detector = new CycleDetector([monitor]);

    expect(recordCycle(detector, monitor.cycle, 'A').triggered).toBe(true);
    detector.reset();

    expect(detector.getHistory()).toEqual([]);
    expect(detector.recordAndCheck('A', 'B').triggered).toBe(false);
  });

  it('never triggers without configured monitors', () => {
    const detector = new CycleDetector();

    expect(detector.recordAndCheck('A', 'A').triggered).toBe(false);
  });
});
