import type {
  AgentResponse,
  Language,
  WorkflowStep,
} from '../../models/types.js';

export type StructuredOutputFailureReason = 'missing' | 'schema_error' | 'timeout' | 'provider_error';

export interface StructuredOutputNormalizeContext {
  readonly step: WorkflowStep;
  readonly language: Language | undefined;
}

export interface StructuredOutputFallbackContext extends StructuredOutputNormalizeContext {
  readonly response: AgentResponse;
  readonly failureReason: StructuredOutputFailureReason;
  readonly detail: string;
  readonly validate: (value: Record<string, unknown>) => void;
}

export interface StructuredOutputNormalizer {
  supports(step: WorkflowStep): boolean;
  normalize(value: Record<string, unknown>, context: StructuredOutputNormalizeContext): Record<string, unknown>;
  buildFailureFallback?(context: StructuredOutputFallbackContext): AgentResponse | undefined;
}

export interface StructuredOutputNormalizerRegistry {
  normalize(
    value: Record<string, unknown>,
    context: StructuredOutputNormalizeContext,
  ): Record<string, unknown>;
  buildFailureFallback(context: StructuredOutputFallbackContext): AgentResponse | undefined;
}

export function createStructuredOutputNormalizerRegistry(
  normalizers: readonly StructuredOutputNormalizer[],
): StructuredOutputNormalizerRegistry {
  return {
    normalize(value, context) {
      const normalizer = normalizers.find((candidate) => candidate.supports(context.step));
      return normalizer ? normalizer.normalize(value, context) : value;
    },
    buildFailureFallback(context) {
      const normalizer = normalizers.find((candidate) => candidate.supports(context.step));
      return normalizer?.buildFailureFallback?.(context);
    },
  };
}
