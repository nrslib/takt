import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import {
  binarySortedUnique,
  computeFindingManagerBudgetScopeId,
  computeFindingManagerProviderCallId,
  computeFindingManagerRequestDigest,
  computeFindingManagerRoundIdentity,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import type {
  FindingManagerAttemptKind,
  FindingManagerCallFailurePhase,
  FindingManagerProviderBudgetLimits,
  FindingManagerProviderBudgetScope,
  FindingManagerProviderCall,
  FindingManagerTokenCharge,
} from '../../models/finding-contract-types.js';
import type { FindingObservation } from './types.js';

export interface AdapterVisibleInputMeasurement {
  requestDigest: string;
  requestByteLength: number;
  measuredAdapterVisibleInputTokens: number;
  inputMeasurementBasis: 'exact_tokenizer' | 'utf8_byte_upper_bound';
}

export type FindingManagerProviderBudgetExhaustionReason =
  | 'adapter_visible_input_ceiling'
  | 'call_count'
  | 'charged_input'
  | 'charged_output';

export class FindingManagerProviderBudgetExhaustedError extends Error {
  readonly reason: FindingManagerProviderBudgetExhaustionReason;

  constructor(reason: FindingManagerProviderBudgetExhaustionReason, message: string) {
    super(message);
    this.name = 'FindingManagerProviderBudgetExhaustedError';
    this.reason = reason;
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

export function assertFindingManagerProviderBudgetLimits(
  limits: FindingManagerProviderBudgetLimits,
): void {
  assertPositiveInteger(limits.maxCallsPerRound, 'maxCallsPerRound');
  assertPositiveInteger(
    limits.maxAdapterVisibleInputBytesPerCall,
    'maxAdapterVisibleInputBytesPerCall',
  );
  assertPositiveInteger(limits.maxOutputTokensPerCall, 'maxOutputTokensPerCall');
  assertPositiveInteger(
    limits.maxChargedInputTokensPerRound,
    'maxChargedInputTokensPerRound',
  );
  assertPositiveInteger(
    limits.maxChargedOutputTokensPerRound,
    'maxChargedOutputTokensPerRound',
  );
}

export function measureAdapterVisibleInput(input: {
  requestBytes: string;
  exactTokenCount?: number;
  adapterSupportsUtf8ByteUpperBound: boolean;
}): AdapterVisibleInputMeasurement {
  const requestByteLength = Buffer.byteLength(input.requestBytes, 'utf8');
  if (input.exactTokenCount !== undefined) {
    assertPositiveInteger(input.exactTokenCount, 'exactTokenCount');
    return {
      requestDigest: computeFindingManagerRequestDigest(input.requestBytes),
      requestByteLength,
      measuredAdapterVisibleInputTokens: input.exactTokenCount,
      inputMeasurementBasis: 'exact_tokenizer',
    };
  }
  if (!input.adapterSupportsUtf8ByteUpperBound) {
    throw new Error(
      'Provider adapter must supply an exact tokenizer or the UTF-8 byte upper-bound contract',
    );
  }
  return {
    requestDigest: computeFindingManagerRequestDigest(input.requestBytes),
    requestByteLength,
    measuredAdapterVisibleInputTokens: requestByteLength,
    inputMeasurementBasis: 'utf8_byte_upper_bound',
  };
}

export function ensureFindingManagerBudgetScope(input: {
  scopes: readonly FindingManagerProviderBudgetScope[];
  scopeIdentity: string;
  workflowName: string;
  roundMarker: string;
  limits: FindingManagerProviderBudgetLimits;
  createdAt: FindingObservation;
}): {
  scopes: FindingManagerProviderBudgetScope[];
  scope: FindingManagerProviderBudgetScope;
} {
  assertFindingManagerProviderBudgetLimits(input.limits);
  const roundIdentity = computeFindingManagerRoundIdentity(input);
  const matching = input.scopes.filter((scope) => scope.roundIdentity === roundIdentity);
  if (matching.length > 1) {
    throw new Error(`Provider budget round "${roundIdentity}" has multiple scopes`);
  }
  const existing = matching[0];
  if (existing !== undefined) {
    if (canonicalJson(existing.limits) !== canonicalJson(input.limits)) {
      throw new Error(`Provider budget round "${roundIdentity}" limits do not match`);
    }
    return { scopes: [...input.scopes], scope: existing };
  }
  const scope: FindingManagerProviderBudgetScope = {
    budgetScopeId: computeFindingManagerBudgetScopeId(roundIdentity),
    roundIdentity,
    scopeIdentity: input.scopeIdentity,
    workflowName: input.workflowName,
    roundMarker: input.roundMarker,
    limits: structuredClone(input.limits),
    createdAt: structuredClone(input.createdAt),
  };
  return { scopes: [...input.scopes, scope], scope };
}

function reservedCharge(call: FindingManagerProviderCall): FindingManagerTokenCharge {
  if (call.state === 'settled') {
    return call.charge;
  }
  return {
    callCount: 1,
    inputTokens: call.reservedInputTokens,
    outputTokens: call.reservedOutputTokens,
    inputBasis: 'request_ceiling',
    outputBasis: 'response_ceiling',
  };
}

export function deriveFindingManagerProviderCharge(input: {
  calls: readonly FindingManagerProviderCall[];
  budgetScopeId: string;
}): { callCount: number; inputTokens: number; outputTokens: number } {
  const charges = input.calls
    .filter((call) => call.budgetScopeId === input.budgetScopeId)
    .map(reservedCharge);
  return {
    callCount: charges.length,
    inputTokens: charges.reduce((total, charge) => total + charge.inputTokens, 0),
    outputTokens: charges.reduce((total, charge) => total + charge.outputTokens, 0),
  };
}

function nextCallOrdinal(
  calls: readonly FindingManagerProviderCall[],
  budgetScopeId: string,
): number {
  const ordinals = calls
    .filter((call) => call.budgetScopeId === budgetScopeId)
    .map((call) => call.callOrdinal)
    .sort((left, right) => left - right);
  ordinals.forEach((ordinal, index) => {
    if (ordinal !== index + 1) {
      throw new Error(`Provider budget scope "${budgetScopeId}" has a non-contiguous call ordinal`);
    }
  });
  return ordinals.length + 1;
}

function assertReservationFits(input: {
  scope: FindingManagerProviderBudgetScope;
  calls: readonly FindingManagerProviderCall[];
  measurement: AdapterVisibleInputMeasurement;
}): void {
  const limits = input.scope.limits;
  if (
    input.measurement.requestByteLength
      > limits.maxAdapterVisibleInputBytesPerCall
  ) {
    throw new FindingManagerProviderBudgetExhaustedError(
      'adapter_visible_input_ceiling',
      'Provider request exceeds the adapter-visible input ceiling',
    );
  }
  const aggregate = deriveFindingManagerProviderCharge({
    calls: input.calls,
    budgetScopeId: input.scope.budgetScopeId,
  });
  const scopeCallCount = input.calls.filter(
    (call) => call.budgetScopeId === input.scope.budgetScopeId,
  ).length;
  if (scopeCallCount + 1 > limits.maxCallsPerRound) {
    throw new FindingManagerProviderBudgetExhaustedError(
      'call_count',
      'Provider call count budget is exhausted',
    );
  }
  if (
    aggregate.inputTokens + input.measurement.measuredAdapterVisibleInputTokens
    > limits.maxChargedInputTokensPerRound
  ) {
    throw new FindingManagerProviderBudgetExhaustedError(
      'charged_input',
      'Provider charged input budget is exhausted',
    );
  }
  if (
    aggregate.outputTokens + limits.maxOutputTokensPerCall
    > limits.maxChargedOutputTokensPerRound
  ) {
    throw new FindingManagerProviderBudgetExhaustedError(
      'charged_output',
      'Provider charged output budget is exhausted',
    );
  }
}

export function reserveFindingManagerProviderCall(input: {
  scopes: readonly FindingManagerProviderBudgetScope[];
  calls: readonly FindingManagerProviderCall[];
  scopeIdentity: string;
  workflowName: string;
  roundMarker: string;
  limits: FindingManagerProviderBudgetLimits;
  purpose: FindingManagerAttemptKind;
  ownerAttemptKind: FindingManagerAttemptKind;
  attemptIds: readonly string[];
  requestBytes: string;
  exactTokenCount?: number;
  adapterSupportsUtf8ByteUpperBound: boolean;
  reservedAt: FindingObservation;
}): {
  scopes: FindingManagerProviderBudgetScope[];
  calls: FindingManagerProviderCall[];
  scope: FindingManagerProviderBudgetScope;
  call: FindingManagerProviderCall;
} {
  if (input.ownerAttemptKind !== input.purpose) {
    throw new Error('Provider call owner attempt kind must match its purpose');
  }
  const attemptIds = binarySortedUnique(input.attemptIds);
  const ownerAttemptId = attemptIds[0];
  if (ownerAttemptId === undefined) {
    throw new Error('Provider call must own at least one attempt');
  }
  if (input.purpose !== 'interpretation' && attemptIds.length !== 1) {
    throw new Error(`${input.purpose} provider calls must own exactly one attempt`);
  }
  const ensured = ensureFindingManagerBudgetScope({
    scopes: input.scopes,
    scopeIdentity: input.scopeIdentity,
    workflowName: input.workflowName,
    roundMarker: input.roundMarker,
    limits: input.limits,
    createdAt: input.reservedAt,
  });
  const measurement = measureAdapterVisibleInput(input);
  assertReservationFits({
    scope: ensured.scope,
    calls: input.calls,
    measurement,
  });
  const callOrdinal = nextCallOrdinal(input.calls, ensured.scope.budgetScopeId);
  const providerCallId = computeFindingManagerProviderCallId({
    budgetScopeId: ensured.scope.budgetScopeId,
    callOrdinal,
    purpose: input.purpose,
    attemptIds,
    requestDigest: measurement.requestDigest,
  });
  const call: FindingManagerProviderCall = {
    providerCallId,
    budgetScopeId: ensured.scope.budgetScopeId,
    purpose: input.purpose,
    callOrdinal,
    ownerAttemptKind: input.ownerAttemptKind,
    ownerAttemptId,
    attemptIds,
    ...measurement,
    reservedInputTokens: measurement.measuredAdapterVisibleInputTokens,
    reservedOutputTokens: ensured.scope.limits.maxOutputTokensPerCall,
    reservedAt: structuredClone(input.reservedAt),
    state: 'reserved',
  };
  return {
    scopes: ensured.scopes,
    calls: [...input.calls, call],
    scope: ensured.scope,
    call,
  };
}

function findExactCall(
  calls: readonly FindingManagerProviderCall[],
  providerCallId: string,
): FindingManagerProviderCall {
  const matching = calls.filter((call) => call.providerCallId === providerCallId);
  if (matching.length !== 1) {
    throw new Error(`Provider call "${providerCallId}" must exist exactly once`);
  }
  return matching[0]!;
}

export function dispatchFindingManagerProviderCall(input: {
  calls: readonly FindingManagerProviderCall[];
  providerCallId: string;
  requestBytes: string;
  exactTokenCount?: number;
  adapterSupportsUtf8ByteUpperBound: boolean;
  dispatchedAt: FindingObservation;
}): { calls: FindingManagerProviderCall[]; call: FindingManagerProviderCall } {
  const current = findExactCall(input.calls, input.providerCallId);
  if (current.state !== 'reserved') {
    throw new Error(`Provider call "${input.providerCallId}" is already ${current.state}`);
  }
  const measurement = measureAdapterVisibleInput(input);
  if (
    measurement.requestDigest !== current.requestDigest
    || measurement.requestByteLength !== current.requestByteLength
    || measurement.measuredAdapterVisibleInputTokens
      !== current.measuredAdapterVisibleInputTokens
    || measurement.inputMeasurementBasis !== current.inputMeasurementBasis
  ) {
    throw new Error(`Provider call "${input.providerCallId}" request changed after reservation`);
  }
  if (measurement.measuredAdapterVisibleInputTokens > current.reservedInputTokens) {
    throw new Error(`Provider call "${input.providerCallId}" exceeds its input reservation`);
  }
  const call: FindingManagerProviderCall = {
    ...current,
    state: 'dispatched',
    dispatchedAt: structuredClone(input.dispatchedAt),
  };
  return {
    calls: input.calls.map((candidate) => (
      candidate.providerCallId === call.providerCallId ? call : candidate
    )),
    call,
  };
}

export function responseUpperBound(input: {
  responseBytes: string;
  exactTokenCount?: number;
}): {
  responseDigest: string;
  tokens: number;
  basis: 'exact_tokenizer' | 'utf8_byte_upper_bound';
} {
  const responseDigest = findingContentAddress('finding-manager-provider-response', {
    responseBytes: input.responseBytes,
  });
  if (input.exactTokenCount !== undefined) {
    assertPositiveInteger(input.exactTokenCount, 'response exactTokenCount');
    return { responseDigest, tokens: input.exactTokenCount, basis: 'exact_tokenizer' };
  }
  return {
    responseDigest,
    tokens: Buffer.byteLength(input.responseBytes, 'utf8'),
    basis: 'utf8_byte_upper_bound',
  };
}

export function settleFindingManagerProviderCall(input: {
  calls: readonly FindingManagerProviderCall[];
  providerCallId: string;
  settledAt: FindingObservation;
  resultKind: 'accepted' | 'rejected' | 'interrupted_unknown';
  failurePhase?: FindingManagerCallFailurePhase;
  response?: { bytes: string; exactTokenCount?: number };
  providerUsage?: { inputTokens: number; outputTokens: number };
}): { calls: FindingManagerProviderCall[]; call: FindingManagerProviderCall } {
  const current = findExactCall(input.calls, input.providerCallId);
  if (current.state !== 'dispatched') {
    throw new Error(`Provider call "${input.providerCallId}" cannot settle from ${current.state}`);
  }
  if (input.resultKind === 'accepted' && input.failurePhase !== undefined) {
    throw new Error('Accepted provider calls cannot have a failure phase');
  }
  if (input.resultKind !== 'accepted' && input.failurePhase === undefined) {
    throw new Error('Rejected or interrupted provider calls require a failure phase');
  }
  const observed = input.response === undefined ? undefined : responseUpperBound({
    responseBytes: input.response.bytes,
    ...(input.response.exactTokenCount === undefined
      ? {}
      : { exactTokenCount: input.response.exactTokenCount }),
  });
  const providerUsage = input.providerUsage;
  if (providerUsage !== undefined) {
    if (
      !Number.isSafeInteger(providerUsage.inputTokens)
      || providerUsage.inputTokens < 0
      || !Number.isSafeInteger(providerUsage.outputTokens)
      || providerUsage.outputTokens < 0
    ) {
      throw new Error('Provider usage must contain non-negative safe integers');
    }
  }
  const interrupted = input.resultKind === 'interrupted_unknown';
  const inputTokens = interrupted
    ? Math.max(current.reservedInputTokens, current.measuredAdapterVisibleInputTokens)
    : providerUsage === undefined
      ? Math.max(current.reservedInputTokens, current.measuredAdapterVisibleInputTokens)
      : Math.max(providerUsage.inputTokens, current.measuredAdapterVisibleInputTokens);
  const observedOutput = observed?.tokens ?? 0;
  const outputTokens = interrupted
    ? Math.max(current.reservedOutputTokens, observedOutput)
    : providerUsage === undefined
      ? Math.max(current.reservedOutputTokens, observedOutput)
      : Math.max(providerUsage.outputTokens, observedOutput);
  const charge: FindingManagerTokenCharge = {
    callCount: 1,
    inputTokens,
    outputTokens,
    inputBasis: interrupted
      ? 'failure_ceiling'
      : providerUsage === undefined
        ? 'request_ceiling'
        : 'provider_usage',
    outputBasis: interrupted
      ? 'failure_ceiling'
      : providerUsage === undefined
        ? 'response_ceiling'
        : 'provider_usage',
  };
  const call: FindingManagerProviderCall = {
    ...current,
    state: 'settled',
    settledAt: structuredClone(input.settledAt),
    resultKind: input.resultKind,
    ...(input.failurePhase === undefined ? {} : { failurePhase: input.failurePhase }),
    ...(observed === undefined ? {} : { responseDigest: observed.responseDigest }),
    charge,
  };
  return {
    calls: input.calls.map((candidate) => (
      candidate.providerCallId === call.providerCallId ? call : candidate
    )),
    call,
  };
}
