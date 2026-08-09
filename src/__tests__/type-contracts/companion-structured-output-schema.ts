import { executeCompanionReviewRound } from '../../core/workflow/companion/review-round.js';
import { executeCompanionStructuredAgent } from '../../core/workflow/companion/review-runner.js';
import { CompanionStructuredCaller } from '../../core/workflow/companion/structured-call.js';

type ReviewRoundSchema = Parameters<
  Parameters<typeof executeCompanionReviewRound>[0]['callStructured']
>[4];
type ReviewRunnerSchema = Parameters<
  typeof executeCompanionStructuredAgent
>[0]['outputSchema'];
type ReviewRunnerCallSchema = Parameters<
  Parameters<typeof executeCompanionStructuredAgent>[0]['call']
>[2];
type StructuredCallerSchema = Parameters<
  CompanionStructuredCaller['call']
>[0]['outputSchema'];

// @ts-expect-error Companion review round schemas must be records, not arrays.
const reviewRoundArraySchema: ReviewRoundSchema = [];
// @ts-expect-error Companion review round schemas must be records, not functions.
const reviewRoundFunctionSchema: ReviewRoundSchema = () => undefined;

// @ts-expect-error Companion review runner schemas must be records, not arrays.
const reviewRunnerArraySchema: ReviewRunnerSchema = [];
// @ts-expect-error Companion review runner schemas must be records, not functions.
const reviewRunnerFunctionSchema: ReviewRunnerSchema = () => undefined;

// @ts-expect-error Companion review runner callbacks must receive records, not arrays.
const reviewRunnerCallArraySchema: ReviewRunnerCallSchema = [];
// @ts-expect-error Companion review runner callbacks must receive records, not functions.
const reviewRunnerCallFunctionSchema: ReviewRunnerCallSchema = () => undefined;

// @ts-expect-error Companion structured callers must receive records, not arrays.
const structuredCallerArraySchema: StructuredCallerSchema = [];
// @ts-expect-error Companion structured callers must receive records, not functions.
const structuredCallerFunctionSchema: StructuredCallerSchema = () => undefined;
