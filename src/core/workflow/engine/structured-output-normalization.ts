import type { AgentResponse } from '../../models/types.js';
import type { ReviewerRawResourceEnvelope } from '../findings/raw-canonicalization.js';

export interface StructuredOutputNormalizationResult {
  readonly response: AgentResponse;
  readonly reviewerRawResourceEnvelope?: ReviewerRawResourceEnvelope;
  readonly invalidDetail?: string;
  readonly invalidKind?: 'model_output' | 'schema_config';
  readonly invalidIssues?: readonly {
    readonly path: string;
    readonly keyword: string;
    readonly message: string;
  }[];
}
