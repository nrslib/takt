import type { AgentWorkflowStep } from '../../models/types.js';
import { RAW_DECISION_KINDS } from './types.js';
import { RAW_ADJUDICATION_RECOVERY_LIMITS } from './raw-finding-limits.js';

export const RAW_ADJUDICATION_SCHEMA_REF = 'takt.findings.raw-adjudication';

const disabledDecisionItemsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {},
} as const;

const rawAdjudicationDecisionJsonProperties = {
  rawFindingId: {
    type: 'string',
    minLength: 71,
    maxLength: 71,
    pattern: '^replay-[0-9a-f]{64}$',
  },
  decision: { type: 'string', enum: RAW_DECISION_KINDS },
  findingId: {
    type: 'string',
    maxLength: 6,
    pattern: '^(|F-[0-9]{4})$',
  },
  // absence の anchorRelevance を含め、制御文字が JSON 上で6 bytesへ
  // 膨張しても4回分の応答が step 予算内に収まる上限。
  evidence: { type: 'string', minLength: 1, maxLength: 52 },
} as const;

export const RawAdjudicationDecisionsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rawDecisions', 'disputeDecisions', 'conflictDecisions', 'invalidateDecisions', 'duplicateDecisions', 'dismissDecisions'],
  properties: {
    rawDecisions: {
      type: 'array',
      maxItems: RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayCandidatesPerBatch,
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: Object.keys(rawAdjudicationDecisionJsonProperties),
            properties: rawAdjudicationDecisionJsonProperties,
          },
          {
            type: 'object',
            additionalProperties: false,
            required: [
              ...Object.keys(rawAdjudicationDecisionJsonProperties),
              'anchorRelevance',
            ],
            properties: {
              ...rawAdjudicationDecisionJsonProperties,
              anchorRelevance: {
                type: 'string',
                enum: ['relevant', 'not_relevant'],
                description: 'Required only for absence targets.',
              },
            },
          },
        ],
      },
    },
    disputeDecisions: {
      type: 'array',
      maxItems: 0,
      items: disabledDecisionItemsSchema,
    },
    conflictDecisions: {
      type: 'array',
      maxItems: 0,
      items: disabledDecisionItemsSchema,
    },
    invalidateDecisions: {
      type: 'array',
      maxItems: 0,
      items: disabledDecisionItemsSchema,
    },
    duplicateDecisions: {
      type: 'array',
      maxItems: 0,
      items: disabledDecisionItemsSchema,
    },
    dismissDecisions: {
      type: 'array',
      maxItems: 0,
      items: disabledDecisionItemsSchema,
    },
  },
} as const;

export function buildRawAdjudicationManagerStep(managerStep: AgentWorkflowStep): AgentWorkflowStep {
  return {
    ...managerStep,
    structuredOutput: {
      schemaRef: RAW_ADJUDICATION_SCHEMA_REF,
      schema: RawAdjudicationDecisionsJsonSchema,
    },
  };
}
