/**
 * Unit tests for faceted-prompting type definitions.
 *
 * Verifies that types are correctly exported and usable.
 */

import { describe, it, expect } from 'vitest';
import type {
  FacetKind,
  FacetContent,
  FacetSet,
  ComposedPrompt,
  ComposeOptions,
} from '../../faceted-prompting/index.js';

describe('FacetKind type', () => {
  it('should accept valid facet kinds', () => {
    const kinds: FacetKind[] = [
      'personas',
      'policies',
      'knowledge',
      'instructions',
      'output-contracts',
    ];
    expect(kinds).toHaveLength(5);
  });
});

describe('FacetContent interface', () => {
  it('should accept body with sourcePath', () => {
    const content: FacetContent = {
      body: 'You are a helpful assistant.',
      sourcePath: '/path/to/persona.md',
    };
    expect(content.body).toBe('You are a helpful assistant.');
    expect(content.sourcePath).toBe('/path/to/persona.md');
  });

  it('should accept body without sourcePath', () => {
    const content: FacetContent = {
      body: 'Inline content',
    };
    expect(content.body).toBe('Inline content');
    expect(content.sourcePath).toBeUndefined();
  });
});

describe('FacetSet interface', () => {
  it('should accept a complete facet set', () => {
    const set: FacetSet = {
      persona: { body: 'You are a coder.' },
      policies: [{ body: 'Follow clean code.' }],
      knowledge: [{ body: 'Architecture docs.' }],
      instruction: { body: 'Implement the feature.' },
    };
    expect(set.persona?.body).toBe('You are a coder.');
    expect(set.policies).toHaveLength(1);
  });

  it('should accept a partial facet set', () => {
    const set: FacetSet = {
      instruction: { body: 'Do the task.' },
    };
    expect(set.persona).toBeUndefined();
    expect(set.instruction?.body).toBe('Do the task.');
  });
});

describe('ComposedPrompt interface', () => {
  it('should hold systemPrompt and userMessage', () => {
    const prompt: ComposedPrompt = {
      systemPrompt: 'You are a coder.',
      userMessage: 'Implement feature X.',
    };
    expect(prompt.systemPrompt).toBe('You are a coder.');
    expect(prompt.userMessage).toBe('Implement feature X.');
  });
});

describe('ComposeOptions interface', () => {
  it('should hold contextMaxChars', () => {
    const options: ComposeOptions = {
      contextMaxChars: 2000,
    };
    expect(options.contextMaxChars).toBe(2000);
  });
});
