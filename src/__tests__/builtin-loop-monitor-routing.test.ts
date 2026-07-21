import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

interface RawLoopMonitor {
  cycle: string[];
  judge: {
    instruction?: string;
    rules: Array<{ next: string }>;
  };
}

interface RawWorkflow {
  finding_contract?: unknown;
  loop_monitors?: RawLoopMonitor[];
}

describe('builtin loop monitor facet routing', () => {
  it.each(['ja', 'en'])('should use the FC-specific monitor only in Finding Contract workflows in %s', (language) => {
    const workflowsDir = join(process.cwd(), 'builtins', language, 'workflows');
    let checkedMonitors = 0;

    for (const fileName of readdirSync(workflowsDir).filter((name) => name.endsWith('.yaml'))) {
      const workflow = parseYaml(readFileSync(join(workflowsDir, fileName), 'utf-8')) as RawWorkflow;
      const expectedInstruction = workflow.finding_contract
        ? 'loop-monitor-reviewers-fix-fc'
        : 'loop-monitor-reviewers-fix';
      const relevantMonitors = workflow.loop_monitors?.filter(({ judge }) =>
        judge.instruction === 'loop-monitor-reviewers-fix'
        || judge.instruction === 'loop-monitor-reviewers-fix-fc',
      ) ?? [];

      for (const monitor of relevantMonitors) {
        checkedMonitors++;
        expect(monitor.judge.instruction, `${language}/${fileName}`).toBe(expectedInstruction);
      }
    }

    expect(checkedMonitors).toBeGreaterThan(0);
  });
});
