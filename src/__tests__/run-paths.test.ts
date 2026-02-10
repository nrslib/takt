import { describe, it, expect } from 'vitest';
import { buildRunPaths } from '../core/piece/run/run-paths.js';

describe('buildRunPaths', () => {
  it('should build run-scoped relative and absolute paths', () => {
    const paths = buildRunPaths('/tmp/project', '20260210-demo-task');

    expect(paths.runRootRel).toBe('.takt/runs/20260210-demo-task');
    expect(paths.reportsRel).toBe('.takt/runs/20260210-demo-task/reports');
    expect(paths.contextKnowledgeRel).toBe('.takt/runs/20260210-demo-task/context/knowledge');
    expect(paths.contextPolicyRel).toBe('.takt/runs/20260210-demo-task/context/policy');
    expect(paths.contextPreviousResponsesRel).toBe('.takt/runs/20260210-demo-task/context/previous_responses');
    expect(paths.logsRel).toBe('.takt/runs/20260210-demo-task/logs');
    expect(paths.metaRel).toBe('.takt/runs/20260210-demo-task/meta.json');

    expect(paths.reportsAbs).toBe('/tmp/project/.takt/runs/20260210-demo-task/reports');
    expect(paths.metaAbs).toBe('/tmp/project/.takt/runs/20260210-demo-task/meta.json');
  });
});
