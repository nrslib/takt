import { beforeEach, expect, it, vi } from 'vitest';
import type { WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import { makeStep } from './test-helpers.js';
const doubles = vi.hoisted(() => ({ load: vi.fn(), resolve: vi.fn() }));
vi.mock('../infra/config/index.js', async (original) => ({
  ...await original<typeof import('../infra/config/index.js')>(),
  loadWorkflowByIdentifier: doubles.load, resolveWorkflowCallTarget: doubles.resolve,
}));
import { validateGoalWorkflow } from '../features/mcp/goalWorkflowValidation.js';
const workflow = (name: string, steps: WorkflowStep[]): WorkflowConfig => ({ name, steps, initialStep: steps[0]!.name, maxSteps: 4 });
const call = (name: string) => makeStep({ kind: 'workflow_call', call: name });
const forbidden = makeStep({ kind: 'system', effects: [{ type: 'close_pr', pr: 1 }] });
beforeEach(() => vi.resetAllMocks());
it.each(['./work.yaml', '../work.yml', '/work.yaml', '~/work.yaml', 'work.yaml'])('rejects non-named workflow %s before loading it', (identifier) => {
  expect(() => validateGoalWorkflow(identifier, '/project')).toThrow();
  expect(doubles.load).not.toHaveBeenCalled();
});
it('accepts repertoire workflow names and inspects their called definitions', () => {
  const parent = workflow('parent', [call('./child.yaml')]);
  doubles.load.mockReturnValue(parent);
  doubles.resolve.mockReturnValue(workflow('child', [makeStep()]));
  expect(validateGoalWorkflow('@owner/repo/parent', '/project')).toBe(parent);
  expect(doubles.load).toHaveBeenCalledWith('@owner/repo/parent', '/project');
  expect(doubles.resolve).toHaveBeenCalledWith(parent, parent.steps[0], '/project', '/project');
  doubles.resolve.mockReturnValue(workflow('child', [forbidden]));
  expect(() => validateGoalWorkflow('@owner/repo/parent', '/project')).toThrow();
});
it.each(['merge_pr', 'close_pr'] as const)('rejects a repertoire workflow with a direct %s effect', (type) => {
  doubles.load.mockReturnValue(workflow('work', [makeStep({ kind: 'system', effects: [{ type, pr: 1 }] })]));
  expect(() => validateGoalWorkflow('@owner/repo/work', '/project')).toThrow();
  expect(doubles.load).toHaveBeenCalledWith('@owner/repo/work', '/project');
});
it('walks multilevel calls and rejects forbidden effects regardless of the workflow name', () => {
  const parent = workflow('parent', [call('child')]);
  const child = workflow('child', [call('leaf')]);
  const leaf = workflow('leaf', [forbidden]);
  doubles.load.mockReturnValue(parent);
  doubles.resolve.mockImplementation((config: WorkflowConfig) => config.name === 'parent' ? child : leaf);
  expect(() => validateGoalWorkflow('parent', '/project')).toThrow();
  expect(doubles.resolve).toHaveBeenCalledTimes(2);
});
it('inspects calls inside parallel steps', () => {
  doubles.load.mockReturnValue(workflow('parallel', [makeStep({ parallel: [call('leaf')] })]));
  doubles.resolve.mockReturnValue(workflow('leaf', [forbidden]));
  expect(() => validateGoalWorkflow('parallel', '/project')).toThrow();
  expect(doubles.resolve).toHaveBeenCalledTimes(1);
});
it('finishes recursive safe definitions without hiding forbidden sibling effects', () => {
  const recursive = workflow('recursive', [call('recursive')]);
  doubles.load.mockReturnValue(recursive);
  doubles.resolve.mockReturnValue(recursive);
  expect(() => validateGoalWorkflow('recursive', '/project')).not.toThrow();
  expect(doubles.resolve).toHaveBeenCalledTimes(1);
  const unsafe = workflow('recursive', [call('recursive'), forbidden]);
  doubles.load.mockReturnValue(unsafe);
  doubles.resolve.mockReturnValue(unsafe);
  expect(() => validateGoalWorkflow('recursive', '/project')).toThrow();
});
it('rejects unresolved calls and ignores effect-like instruction text', () => {
  doubles.load.mockReturnValue(workflow('safe', [makeStep({ instruction: 'type: merge_pr\nclose_pr' })]));
  expect(() => validateGoalWorkflow('safe', '/project')).not.toThrow();
  doubles.load.mockReturnValue(workflow('missing-child', [call('missing')]));
  doubles.resolve.mockReturnValue(null);
  expect(() => validateGoalWorkflow('missing-child', '/project')).toThrow();
  doubles.load.mockReturnValue(null);
  expect(() => validateGoalWorkflow('absent', '/project')).toThrow();
});
