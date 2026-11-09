import { beforeEach, expect, it, vi } from 'vitest';
import { resolveManagerWorkflowSelection } from '../features/manager/workflowSelection.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowLoader.js';

vi.mock('../infra/config/loaders/workflowLoader.js', () => ({ loadWorkflowByIdentifier: vi.fn() }));
beforeEach(() => {
  vi.mocked(loadWorkflowByIdentifier).mockImplementation((name) => name === 'missing' ? null : {
    name, description: `Workflow ${name}`, initialStep: 'work', maxSteps: 2, steps: [],
  });
});

it('defaults to default and simple with descriptions in the configured language', () => {
  const ja = resolveManagerWorkflowSelection('/repo', {}, 'ja');
  const en = resolveManagerWorkflowSelection('/repo', {}, 'en');
  expect(ja.workflows?.map(({ name }) => name)).toEqual(['default', 'simple']);
  expect(en.workflows?.map(({ name }) => name)).toEqual(['default', 'simple']);
  for (const selection of [ja, en]) {
    expect(selection.missingWorkflows).toEqual([]);
    for (const workflow of selection.workflows!) expect(workflow.usageDescription).toEqual(expect.any(String));
  }
  expect(ja.workflows?.map(({ usageDescription }) => usageDescription)).not.toEqual(en.workflows?.map(({ usageDescription }) => usageDescription));
});

it('keeps mixed entries and adds the default workflow without replacing usage descriptions', () => {
  expect(resolveManagerWorkflowSelection('/repo', {
    workflows: ['simple', { custom: 'Custom work' }], defaultWorkflow: 'default',
  }, 'ja')).toEqual({ workflows: [
    { name: 'simple', description: 'Workflow simple' },
    { name: 'custom', description: 'Workflow custom', usageDescription: 'Custom work' },
    { name: 'default', description: 'Workflow default' },
  ], missingWorkflows: [] });
  expect(resolveManagerWorkflowSelection('/repo', {
    workflows: [{ default: 'Explicit usage' }], defaultWorkflow: 'default',
  }, 'en').workflows).toEqual([{ name: 'default', description: 'Workflow default', usageDescription: 'Explicit usage' }]);
});

it('ignores missing names and reports them for startup warnings', () => {
  expect(resolveManagerWorkflowSelection('/repo', { workflows: ['simple', 'missing'], defaultWorkflow: 'missing' }, 'en'))
    .toEqual({ workflows: [{ name: 'simple', description: 'Workflow simple' }], missingWorkflows: ['missing'] });
});

it('allows every workflow when all is configured', () => {
  expect(resolveManagerWorkflowSelection('/repo', { workflows: 'all' }, 'en')).toEqual({ missingWorkflows: [] });
});
