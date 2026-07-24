import {
  FINDING_CONTRACT_CHANGED_PATHS_LIMITS,
  FINDING_CONTRACT_LITERAL_PATH_PATTERN,
} from './team-leader-finding-contract-validation.js';

const nonEmptyStringSchema = { type: 'string', minLength: 1 } as const;
const stringArraySchema = {
  type: 'array',
  items: nonEmptyStringSchema,
} as const;
const literalPathArraySchema = {
  type: 'array',
  items: {
    ...nonEmptyStringSchema,
    pattern: FINDING_CONTRACT_LITERAL_PATH_PATTERN,
  },
} as const;
const changedPathArraySchema = {
  ...literalPathArraySchema,
  maxItems: FINDING_CONTRACT_CHANGED_PATHS_LIMITS.maxItems,
  items: {
    ...literalPathArraySchema.items,
    maxLength: FINDING_CONTRACT_CHANGED_PATHS_LIMITS.maxItemLength,
  },
} as const;
const findingContractAssignmentSchema = {
  type: 'object',
  properties: {
    findingIds: stringArraySchema,
    role: { type: 'string', enum: ['diagnose', 'repair', 'verify'] },
    writePaths: literalPathArraySchema,
    readPaths: literalPathArraySchema,
  },
  required: ['findingIds', 'role', 'writePaths', 'readPaths'],
  additionalProperties: false,
} as const;
const findingContractPartSchema = {
  type: 'object',
  properties: {
    id: nonEmptyStringSchema,
    title: nonEmptyStringSchema,
    instruction: nonEmptyStringSchema,
    findingContract: findingContractAssignmentSchema,
  },
  required: ['id', 'title', 'instruction', 'findingContract'],
  additionalProperties: false,
} as const;

const findingContractDecompositionJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    parts: { type: 'array', minItems: 1, items: findingContractPartSchema },
  },
  required: ['parts'],
  additionalProperties: false,
};

const findingContractFeedbackJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['continue', 'complete', 'replan'] },
    reasoning: nonEmptyStringSchema,
    parts: { type: 'array', items: findingContractPartSchema },
    fixCoverage: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          findingId: nonEmptyStringSchema,
          disposition: { type: 'string', enum: ['addressed', 'disputed'] },
          supportingPartIds: stringArraySchema,
          verificationPartIds: stringArraySchema,
        },
        required: ['findingId', 'disposition', 'supportingPartIds', 'verificationPartIds'],
        additionalProperties: false,
      },
    },
    blockers: stringArraySchema,
  },
  required: ['decision', 'reasoning', 'parts', 'fixCoverage', 'blockers'],
  additionalProperties: false,
};

const findingContractPartCompletionJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    findingOutcomes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          findingId: nonEmptyStringSchema,
          outcome: { type: 'string', enum: ['addressed', 'disputed', 'blocked'] },
          evidence: stringArraySchema,
        },
        required: ['findingId', 'outcome', 'evidence'],
        additionalProperties: false,
      },
    },
    changedPaths: changedPathArraySchema,
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: nonEmptyStringSchema,
          status: { type: 'string', enum: ['passed', 'failed', 'not_run'] },
        },
        required: ['command', 'status'],
        additionalProperties: false,
      },
    },
    summary: nonEmptyStringSchema,
  },
  required: ['findingOutcomes', 'changedPaths', 'checks', 'summary'],
  additionalProperties: false,
};

export function createFindingContractDecompositionJsonSchema(): Record<string, unknown> {
  return structuredClone(findingContractDecompositionJsonSchema);
}

export function createFindingContractFeedbackJsonSchema(): Record<string, unknown> {
  return structuredClone(findingContractFeedbackJsonSchema);
}

export function createFindingContractPartCompletionJsonSchema(): Record<string, unknown> {
  return structuredClone(findingContractPartCompletionJsonSchema);
}
