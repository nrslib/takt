import type { AgentResponse } from '../models/types.js';
import { projectNativeStructuredOutputSchema } from '../models/native-structured-output-schema.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { validateStructuredOutputAgainstSchema } from './engine/structured-output-schema-validator.js';

export interface SelectorCandidate {
  readonly name: string;
  readonly description: string;
}

export interface SelectorResponseLabel {
  readonly label: string;
}

export interface SelectorContract {
  readonly providerSchema: Record<string, unknown>;
  readonly validationSchema: Record<string, unknown>;
}

export function createSelectorContract(
  candidates: readonly SelectorCandidate[],
  maxSelected?: number,
): SelectorContract {
  const selectedIds: Record<string, unknown> = {
    type: 'array',
    uniqueItems: true,
    items: { type: 'string', enum: candidates.map(({ name }) => name) },
  };
  if (maxSelected !== undefined) selectedIds.maxItems = maxSelected;
  const validationSchema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    properties: {
      selected_ids: selectedIds,
      rationale: { type: 'string' },
    },
    required: ['selected_ids', 'rationale'],
  };
  return {
    providerSchema: projectNativeStructuredOutputSchema(validationSchema),
    validationSchema,
  };
}

export function validateSelectorResponse(
  response: AgentResponse,
  validationSchema: Record<string, unknown>,
  stepName: string,
  redact: (text: string) => string,
  label: SelectorResponseLabel,
): { readonly selectedIds: readonly string[]; readonly rationale: string } {
  if (response.status !== 'done') {
    const category = response.failureCategory ?? response.errorKind;
    const detail = redact(response.error ?? response.content).trim();
    const diagnostics = [
      `status "${response.status}"`,
      ...(category === undefined ? [] : [`category "${category}"`]),
      ...(detail.length === 0 ? [] : [detail]),
    ].join(': ');
    throw new Error(`${label.label} selector for "${stepName}" failed with ${diagnostics}`);
  }
  try {
    validateStructuredOutputAgainstSchema(response.structuredOutput, validationSchema);
  } catch (error) {
    throw new Error(redact(
      `${label.label} selector for "${stepName}" returned invalid structured output: ${getErrorMessage(error)}`,
    ));
  }
  const selection = response.structuredOutput as {
    readonly selected_ids: readonly string[];
    readonly rationale: string;
  };
  return {
    selectedIds: selection.selected_ids,
    rationale: redact(selection.rationale),
  };
}
