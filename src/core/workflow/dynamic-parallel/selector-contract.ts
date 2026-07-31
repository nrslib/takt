import type { AgentResponse } from '../../models/types.js';
import { getErrorMessage } from '../../../shared/utils/index.js';
import { validateStructuredOutputAgainstSchema } from '../engine/structured-output-schema-validator.js';

export function createSelectorOutputSchema(poolIds: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      selected_ids: {
        type: 'array',
        uniqueItems: true,
        items: { type: 'string', enum: poolIds },
      },
      rationale: { type: 'string' },
    },
    required: ['selected_ids', 'rationale'],
  };
}

export function validateSelectorResponse(
  response: AgentResponse,
  outputSchema: Record<string, unknown>,
  stepName: string,
  redact: (text: string) => string,
): { readonly selectedIds: readonly string[]; readonly rationale: string } {
  if (response.status !== 'done') {
    const category = response.failureCategory ?? response.errorKind;
    const detail = redact(response.error ?? response.content).trim();
    const diagnostics = [
      `status "${response.status}"`,
      ...(category === undefined ? [] : [`category "${category}"`]),
      ...(detail.length === 0 ? [] : [detail]),
    ].join(': ');
    throw new Error(`Dynamic parallel selector for "${stepName}" failed with ${diagnostics}`);
  }
  const structuredOutput = response.structuredOutput;
  try {
    validateStructuredOutputAgainstSchema(structuredOutput, outputSchema);
  } catch (error) {
    throw new Error(
      redact(
        `Dynamic parallel selector for "${stepName}" returned invalid structured output: ${getErrorMessage(error)}`,
      ),
    );
  }
  const selection = structuredOutput as {
    readonly selected_ids: readonly string[];
    readonly rationale: string;
  };
  return {
    selectedIds: selection.selected_ids,
    rationale: redact(selection.rationale),
  };
}
