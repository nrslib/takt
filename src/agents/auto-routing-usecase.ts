import type { AutoRoutingConfig } from '../core/models/config-types.js';
import {
  ROUTING_REASON_CODE_VALUES,
  validateRoutingReasonCodes,
  type WorkRequirementEstimator,
  type WorkRequirementEstimate,
  type RoutingModelInput,
} from '../core/workflow/auto-routing/contracts.js';
import { assertStrictStructuredOutputSchema } from '../core/workflow/engine/structured-output-schema-validator.js';
import { runAgent, type RunAgentOptions } from './runner.js';
import { buildMaxTurnsOption } from './provider-call-options.js';
import {
  createAgentFailureError,
} from '../shared/types/agent-failure.js';

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    required_tier: { type: 'string', enum: ['low', 'medium', 'high'] },
    reason_codes: {
      type: 'array',
      items: {
        type: 'string',
        enum: ROUTING_REASON_CODE_VALUES,
      },
    },
    confidence: { type: ['number', 'null'] },
  },
  required: ['required_tier', 'reason_codes', 'confidence'],
};

const WORK_REQUIREMENT_ESTIMATOR_TIMEOUT_MS = 30_000;

export interface WorkRequirementEstimatorOptions {
  cwd: string;
  provider: AutoRoutingConfig['router']['provider'];
  model: string;
  language?: RunAgentOptions['language'];
  childProcessEnv?: RunAgentOptions['childProcessEnv'];
  abortSignal?: RunAgentOptions['abortSignal'];
  failureDir?: RunAgentOptions['failureDir'];
}

interface EstimatorAbortScope {
  signal: AbortSignal;
  aborted: Promise<never>;
  cleanup(): void;
}

function toAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Auto routing estimator aborted');
}

function createEstimatorAbortScope(signals: readonly (AbortSignal | undefined)[]): EstimatorAbortScope {
  const controller = new AbortController();
  const listenerScope = new AbortController();
  const abortFrom = (signal: AbortSignal): void => {
    controller.abort(signal.reason);
  };

  for (const signal of signals) {
    if (signal?.aborted) {
      abortFrom(signal);
      break;
    }
    signal?.addEventListener('abort', () => abortFrom(signal), {
      once: true,
      signal: listenerScope.signal,
    });
  }

  const timeoutId = controller.signal.aborted
    ? undefined
    : setTimeout(() => {
        controller.abort(
          new Error(`Auto routing estimator timed out after ${WORK_REQUIREMENT_ESTIMATOR_TIMEOUT_MS}ms`),
        );
      }, WORK_REQUIREMENT_ESTIMATOR_TIMEOUT_MS);
  const aborted = new Promise<never>((_, reject) => {
    const rejectOnAbort = (): void => reject(toAbortError(controller.signal.reason));
    if (controller.signal.aborted) {
      rejectOnAbort();
      return;
    }
    controller.signal.addEventListener('abort', rejectOnAbort, {
      once: true,
      signal: listenerScope.signal,
    });
  });

  return {
    signal: controller.signal,
    aborted,
    cleanup(): void {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      listenerScope.abort();
    },
  };
}

function parseEstimate(parsed: unknown): WorkRequirementEstimate {
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Auto routing estimator response must be an object');
  const value = parsed as Record<string, unknown>;
  if (value.required_tier !== 'low' && value.required_tier !== 'medium' && value.required_tier !== 'high') {
    throw new Error('Auto routing estimator response has an invalid required_tier');
  }
  validateRoutingReasonCodes(value.reason_codes);
  if (value.confidence !== undefined && value.confidence !== null && typeof value.confidence !== 'number') {
    throw new Error('Auto routing estimator response has invalid confidence');
  }
  return {
    requiredTier: value.required_tier,
    reasonCodes: [...value.reason_codes],
    ...(typeof value.confidence === 'number' ? { confidence: value.confidence } : {}),
  };
}

function buildPrompt(input: RoutingModelInput): string {
  return [
    'Estimate the minimum routing tier required to complete this work.',
    'Return required_tier as low, medium, or high, with reason_codes from the provided schema only.',
    'Work input:',
    JSON.stringify(input),
  ].join('\n');
}

export function createWorkRequirementEstimator(options: WorkRequirementEstimatorOptions): WorkRequirementEstimator {
  assertStrictStructuredOutputSchema(OUTPUT_SCHEMA);

  return {
    async estimate(
      input: RoutingModelInput,
      estimateOptions?: { abortSignal?: AbortSignal },
    ): Promise<WorkRequirementEstimate> {
      options.abortSignal?.throwIfAborted();
      estimateOptions?.abortSignal?.throwIfAborted();
      const abortScope = createEstimatorAbortScope([
        options.abortSignal,
        estimateOptions?.abortSignal,
      ]);
      try {
        const response = await Promise.race([
          runAgent('auto-router', buildPrompt(input), {
            cwd: options.cwd,
            provider: options.provider,
            resolvedProvider: options.provider,
            model: options.model,
            resolvedModel: options.model,
            ...buildMaxTurnsOption(options.provider, options.provider, 1),
            abortSignal: abortScope.signal,
            permissionMode: 'readonly',
            language: options.language,
            childProcessEnv: options.childProcessEnv,
            failureDir: options.failureDir,
            outputSchema: OUTPUT_SCHEMA,
          }),
          abortScope.aborted,
        ]);
        if (response.status !== 'done') {
          const detail = response.error || response.content || response.status;
          if (response.failureCategory !== undefined) {
            throw createAgentFailureError(response.failureCategory, detail);
          }
          throw new Error(`Auto routing estimator did not complete: ${detail}`);
        }
        return parseEstimate(response.structuredOutput ?? JSON.parse(response.content));
      } finally {
        abortScope.cleanup();
      }
    },
  };
}
