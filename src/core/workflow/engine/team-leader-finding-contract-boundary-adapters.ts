import type {
  AgentResponse,
  FindingContractTeamLeaderDecision,
} from '../../models/types.js';
import type {
  DecomposeTaskResponse,
  MorePartsResponse,
} from '../../../agents/decompose-task-usecase.js';
import { parseLastJsonBlock } from '../../../agents/structured-caller/shared.js';
import {
  createFindingContractDecompositionJsonSchema,
  createFindingContractFeedbackJsonSchema,
} from '../team-leader-finding-contract.js';
import {
  FindingContractDecompositionValidationError,
  validateFindingContractDecomposition,
  type FindingContractRejectedDecompositionDigest,
} from '../team-leader-finding-contract-decomposition-validation.js';
import {
  createFindingContractTeamLeaderDecisionValidationError,
  type FindingContractRejectedDecisionDigest,
} from '../team-leader-finding-contract-decision-validation.js';
import {
  parseFindingContractTeamLeaderDecision,
  type FindingContractDecisionValidationContext,
} from '../team-leader-finding-contract-decision.js';
import {
  createFindingContractControlValidationIssue,
  type FindingContractControlBoundaryKind,
  type FindingContractControlValidationIssue,
} from '../team-leader-finding-contract-control-validation.js';
import {
  assertStructuredOutputSchema,
  StructuredOutputSchemaError,
  StructuredOutputValueValidationError,
  validateStructuredOutputAgainstSchema,
} from './structured-output-schema-validator.js';
import type {
  FindingContractRecoveryAdapter,
  FindingContractRecoveryRequest,
} from './team-leader-finding-contract-recovery.js';

type RawResponseRequest<TDigest extends FindingContractRejectedDecompositionDigest | FindingContractRejectedDecisionDigest> = (
  request: FindingContractRecoveryRequest<TDigest>,
) => Promise<AgentResponse>;

interface DecompositionBoundaryAdapterOptions {
  readonly requestRaw: RawResponseRequest<FindingContractRejectedDecompositionDigest>;
  readonly maxInitialParts: number | undefined;
  readonly targetFindingIds: readonly string[];
}

interface DecisionBoundaryAdapterOptions {
  readonly requestRaw: RawResponseRequest<FindingContractRejectedDecisionDigest>;
  readonly validationContext: FindingContractDecisionValidationContext;
}

export function createFindingContractDecompositionBoundaryAdapter(
  options: DecompositionBoundaryAdapterOptions,
): FindingContractRecoveryAdapter<AgentResponse, DecomposeTaskResponse, FindingContractRejectedDecompositionDigest> {
  const schema = withMaxInitialParts(
    createFindingContractDecompositionJsonSchema(),
    options.maxInitialParts,
  );
  assertBoundarySchema(schema, 'decomposition');
  return {
    boundaryKind: 'decomposition',
    requestOnce: async (request) => toEnvelope(await options.requestRaw(request), request.attemptToken),
    validate: (envelope) => {
      assertDoneResponse(envelope.raw, 'decomposition');
      const rawParts = readDecompositionParts(envelope.raw);
      validateBoundaryValue({ parts: rawParts }, schema, 'decomposition', rawParts);
      return {
        parts: validateFindingContractDecomposition(
          rawParts,
          options.maxInitialParts,
          options.targetFindingIds,
        ),
        ...(envelope.raw.providerUsage === undefined
          ? {}
          : { providerUsage: envelope.raw.providerUsage }),
      };
    },
  };
}

export function createFindingContractDecisionBoundaryAdapter(
  options: DecisionBoundaryAdapterOptions,
): FindingContractRecoveryAdapter<AgentResponse, MorePartsResponse, FindingContractRejectedDecisionDigest> {
  const schema = createFindingContractFeedbackJsonSchema();
  assertBoundarySchema(schema, 'decision');
  return {
    boundaryKind: 'decision',
    requestOnce: async (request) => toEnvelope(await options.requestRaw(request), request.attemptToken),
    validate: (envelope) => {
      assertDoneResponse(envelope.raw, 'decision');
      const rawDecision = envelope.raw.structuredOutput ?? parseDecisionContent(envelope.raw.content);
      validateDecisionValue(rawDecision, schema);
      const decision = parseFindingContractTeamLeaderDecision(
        rawDecision,
        options.validationContext,
      );
      return toMorePartsResponse(decision, envelope.raw);
    },
  };
}

function toEnvelope(response: AgentResponse, attemptToken: string) {
  return {
    raw: response,
    attemptToken,
    ...(response.sessionId === undefined ? {} : { sessionId: response.sessionId }),
    ...(response.providerUsage === undefined ? {} : { usage: response.providerUsage }),
  };
}

function assertDoneResponse(
  response: AgentResponse,
  boundaryKind: FindingContractControlBoundaryKind,
): void {
  if (response.status === 'done') return;
  throw new Error(
    `Finding Contract ${boundaryKind} provider response failed: `
    + `${response.error ?? response.content}`,
  );
}

function readDecompositionParts(response: AgentResponse): unknown {
  if (response.structuredOutput !== undefined) {
    return response.structuredOutput.parts;
  }
  try {
    return parseLastJsonBlock(response.content);
  } catch (error) {
    throw new FindingContractDecompositionValidationError([
      shapeIssue('decomposition', 'shape.json_block', '$', error),
    ], response.content);
  }
}

function parseDecisionContent(content: string): unknown {
  try {
    return parseLastJsonBlock(content);
  } catch (error) {
    throw createFindingContractTeamLeaderDecisionValidationError(content, [{
      code: 'shape.json_block',
      category: 'shape',
      path: '$',
      message: error instanceof Error ? error.message : String(error),
    }]);
  }
}

function validateBoundaryValue(
  value: unknown,
  schema: Record<string, unknown>,
  boundaryKind: 'decomposition',
  raw: unknown,
): void {
  try {
    validateStructuredOutputAgainstSchema(value, schema);
  } catch (error) {
    if (!(error instanceof StructuredOutputValueValidationError)) throw error;
    throw new FindingContractDecompositionValidationError(
      error.issues.map((issue) => shapeIssue(
        boundaryKind,
        `shape.schema.${issue.keyword}`,
        issue.path,
        issue.message,
      )),
      raw,
    );
  }
}

function validateDecisionValue(
  value: unknown,
  schema: Record<string, unknown>,
): void {
  try {
    validateStructuredOutputAgainstSchema(value, schema);
  } catch (error) {
    if (!(error instanceof StructuredOutputValueValidationError)) throw error;
    throw createFindingContractTeamLeaderDecisionValidationError(
      value,
      error.issues.map((issue) => ({
        code: `shape.schema.${issue.keyword}`,
        category: 'shape',
        path: issue.path,
        message: issue.message,
      })),
    );
  }
}

function assertBoundarySchema(
  schema: Record<string, unknown>,
  boundaryKind: FindingContractControlBoundaryKind,
): void {
  try {
    assertStructuredOutputSchema(schema);
  } catch (error) {
    if (!(error instanceof StructuredOutputSchemaError)) throw error;
    const issue = createFindingContractControlValidationIssue({
      boundaryKind,
      code: 'contract.schema_config',
      category: 'contract',
      path: '$',
      message: error.message,
      retryability: 'terminal',
    });
    if (boundaryKind === 'decomposition') {
      throw new FindingContractDecompositionValidationError([issue], schema);
    }
    throw createFindingContractTeamLeaderDecisionValidationError(schema, [{
      code: issue.code,
      category: 'decision_contract',
      path: issue.path,
      message: issue.message,
      retryability: issue.retryability,
    }]);
  }
}

function shapeIssue(
  boundaryKind: 'decomposition',
  code: string,
  path: string,
  error: unknown,
): FindingContractControlValidationIssue {
  return createFindingContractControlValidationIssue({
    boundaryKind,
    code,
    category: 'shape',
    path,
    message: error instanceof Error ? error.message : String(error),
    retryability: 'corrective_retry',
  });
}

function toMorePartsResponse(
  decision: FindingContractTeamLeaderDecision,
  response: AgentResponse,
): MorePartsResponse {
  return {
    done: decision.decision !== 'continue',
    reasoning: decision.reasoning,
    parts: decision.parts,
    findingContractDecision: decision,
    ...(response.providerUsage === undefined ? {} : { providerUsage: response.providerUsage }),
  };
}

function withMaxInitialParts(
  schema: Record<string, unknown>,
  maxInitialParts: number | undefined,
): Record<string, unknown> {
  const clone = structuredClone(schema);
  if (maxInitialParts === undefined) return clone;
  const properties = clone.properties as Record<string, unknown>;
  const parts = properties.parts as Record<string, unknown>;
  parts.maxItems = maxInitialParts;
  return clone;
}
