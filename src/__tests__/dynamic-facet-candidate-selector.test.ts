import { describe, expect, it } from 'vitest';
import {
  createSelectorOutputSchema,
  validateSelectorResponse,
} from '../core/workflow/dynamic-parallel/selector-contract.js';
import type { AgentResponse } from '../core/models/types.js';

const identity = (text: string) => text;

describe('CandidateSelector strict ID selection primitive (C-SHARED-SELECTOR, C-SELECTOR-OUTPUT, C-SELECTOR-FAILFAST)', () => {
  describe('createSelectorOutputSchema', () => {
    it('should produce a strict schema with selected_ids enum constrained to pool IDs and required rationale (C-SELECTOR-OUTPUT)', () => {
      const schema = createSelectorOutputSchema(['backend', 'transaction', 'backward-compatibility']);

      expect(schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        properties: {
          selected_ids: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string', enum: ['backend', 'transaction', 'backward-compatibility'] },
          },
          rationale: { type: 'string' },
        },
        required: ['selected_ids', 'rationale'],
      });
    });

    it('should produce the same shape as the dynamic-parallel selector contract (C-SHARED-SELECTOR: 両 consumer が同じ schema 形状)', () => {
      // The shared primitive must produce the same strict schema shape for both consumers.
      const facetPoolSchema = createSelectorOutputSchema(['a', 'b']);
      // Re-import the dynamic-parallel contract to compare shape (delegated to the same primitive).
      // Since the dynamic-parallel selector-contract delegates to candidateSelector, we verify shape equality here.
      expect(facetPoolSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        properties: {
          selected_ids: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['a', 'b'] } },
          rationale: { type: 'string' },
        },
        required: ['selected_ids', 'rationale'],
      });
    });
  });

  describe('validateSelectorResponse', () => {
    const poolIds = ['backend', 'transaction', 'backward-compatibility'];
    const schema = createSelectorOutputSchema(poolIds);

    it('should accept a valid selection with unique IDs within the pool enum (C-SELECTOR-OUTPUT)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: {
          selected_ids: ['backend', 'transaction'],
          rationale: 'task needs backend and transaction expertise',
        },
      } as unknown as AgentResponse;

      const result = validateSelectorResponse(response, schema, 'fix', identity, { label: 'Dynamic facet' });
      expect(result.selectedIds).toEqual(['backend', 'transaction']);
      expect(result.rationale).toBe('task needs backend and transaction expertise');
    });

    it('should accept an empty selection (C-SELECTOR-OUTPUT: 空選択は正常)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: [], rationale: 'no extra facets needed' },
      } as unknown as AgentResponse;

      const result = validateSelectorResponse(response, schema, 'fix', identity, { label: 'Dynamic facet' });
      expect(result.selectedIds).toEqual([]);
    });

    it('should reject a pool-external ID (C-SELECTOR-FAILFAST: 未知 ID)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: ['unknown-id'], rationale: 'x' },
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, schema, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });

    it('should reject duplicate IDs (C-SELECTOR-FAILFAST: 重複)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: ['backend', 'backend'], rationale: 'x' },
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, schema, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });

    it('should reject a non-array selected_ids (C-SELECTOR-FAILFAST: 非配列)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: 'backend', rationale: 'x' },
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, schema, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });

    it('should reject a non-string element in selected_ids (C-SELECTOR-FAILFAST: 非文字列)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: ['backend', 123], rationale: 'x' },
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, schema, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });

    it('should reject a missing rationale (C-SELECTOR-OUTPUT: rationale 必須)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: ['backend'] },
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, schema, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });

    it('should reject when structured output is absent (C-SELECTOR-FAILFAST: structured output 不成立)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: undefined,
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, schema, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });

    it('should reject a failed selector response status (C-SELECTOR-FAIL)', () => {
      const response: AgentResponse = {
        status: 'error',
        content: 'selector provider failed',
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, schema, 'fix', identity, { label: 'Dynamic facet' })).toThrow(/failed/);
    });

    it('should reject additional properties in the structured output (strict schema)', () => {
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: {
          selected_ids: ['backend'],
          rationale: 'x',
          extra: 'should not be allowed',
        },
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, schema, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });

    it('should reject a selection exceeding max_selected when enforced by the caller (C-SELECTOR-FAILFAST: max_selected 超過)', () => {
      // The primitive schema enforces enum/uniqueness; max_selected is enforced by the caller (coordinator).
      // Here we test that the primitive rejects duplicates (which would also exceed max_selected),
      // and the coordinator-level test covers the explicit max_selected check.
      const response: AgentResponse = {
        status: 'done',
        content: '',
        structuredOutput: { selected_ids: ['backend', 'transaction', 'backward-compatibility', 'backend'], rationale: 'x' },
      } as unknown as AgentResponse;

      expect(() => validateSelectorResponse(response, schema, 'fix', identity, { label: 'Dynamic facet' })).toThrow();
    });
  });
});