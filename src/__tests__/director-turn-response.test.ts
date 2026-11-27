import { expect, it } from 'vitest';
import { getDirectorOutputSchema, parseDirectorResponse } from '../features/director/turnResponse.js';
import { getManagerOutputSchema } from '../features/manager/turnResponse.js';

const summary = { managerId: `manager-${'a'.repeat(64)}`, repositoryDirectory: '/blog',
  objective: 'Publish articles', outOfScope: ['Editing'], acceptanceCriteria: ['List articles'], constraints: [] };
const response = { persona: 'director', status: 'done' as const, content: 'reply', timestamp: new Date() };

it.each(['mock', 'codex'] as const)('requires an assignment in the %s output schema without modifying the manager schema', (provider) => {
  const before = structuredClone(getManagerOutputSchema(provider));
  const schema = getDirectorOutputSchema(provider) as { properties: { summary: { anyOf: { type: string; required: string[]; properties: Record<string, unknown> }[] } } };
  const proposal = schema.properties.summary.anyOf.find((branch) => branch.type === 'object')!;
  expect(proposal.required).toEqual(expect.arrayContaining(['managerId', 'repositoryDirectory']));
  expect(proposal.properties.repositoryDirectory).toEqual({ type: 'string' });
  expect(getManagerOutputSchema(provider)).toEqual(before);
});

it('normalizes Codex nullable fields while preserving the selected manager', () => {
  const parsed = parseDirectorResponse({ ...response, structuredOutput: { message: 'Review the proposal', summary: {
    ...summary, specifications: { gherkin: 'Feature: Articles', quint: null, alloy: null }, startBranch: null, integrationBranch: null,
  } } }, 'codex');
  expect(parsed.summary).toEqual({ ...summary, specifications: { gherkin: 'Feature: Articles' } });
});

it.each([{}, { managerId: 'unknown' }, { repositoryDirectory: 'relative' }, { repositoryDirectory: null }])('rejects an incomplete or invalid director assignment %j', (change) => {
  const proposal = Object.keys(change).length === 0 ? { ...summary, managerId: undefined } : { ...summary, ...change };
  expect(() => parseDirectorResponse({ ...response, structuredOutput: { message: 'Review', summary: proposal } }, 'mock')).toThrow();
});

it('preserves a candidate question without proposing registration', () => {
  expect(parseDirectorResponse({ ...response, content: JSON.stringify({ message: 'Blog A or Blog B?', summary: null }) }, 'mock'))
    .toEqual({ message: 'Blog A or Blog B?', summary: null });
});

it('rejects invalid structured output rather than using a valid content proposal', () => {
  expect(() => parseDirectorResponse({ ...response, content: JSON.stringify({ message: 'Review', summary }),
    structuredOutput: { message: 'Review', summary: {} } }, 'mock')).toThrow();
});
