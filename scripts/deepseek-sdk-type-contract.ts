import * as sdk from '@deepseek-ai/dsh-sdk-client';
import * as llm from '@deepseek-ai/dsh-llm';
import type {
  DeepSeekHarness,
  DeepSeekHarnessOptions,
  DeepSeekHarnessRunResult,
  HarnessNotification,
  ManagedDeepSeekLlm,
  ManagedDeepSeekSdk,
} from '../src/infra/deepseek-harness/sdk-types.js';

type BoundaryReasoningEffortId = ReturnType<ManagedDeepSeekLlm['ReasoningEffortId']>;

const sdkBoundary: ManagedDeepSeekSdk = sdk;
const llmBoundary: ManagedDeepSeekLlm = llm;
const options: sdk.DeepSeekHarnessOptions = {
  dshBin: '/managed/dsh',
  profile: 'sdk',
  patches: ['/managed/profile.patch.yml'],
  dshHome: '/managed/home',
  processCwd: '/workspace',
  env: { PATH: '/usr/bin' },
  initializeTimeoutMs: 30_000,
  requestTimeoutMs: 60_000,
  shutdownTimeoutMs: 1_000,
  disposeEofGraceMs: 15_000,
  disposeGraceMs: 15_000,
  cwd: '/workspace',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: llm.ReasoningEffortId('low'),
  maxTokens: 1_000,
};
const optionsBoundary: DeepSeekHarnessOptions = options;
declare const boundaryOptions: DeepSeekHarnessOptions;
const optionsSdk: sdk.DeepSeekHarnessOptions = boundaryOptions;
const harness: DeepSeekHarness = new sdk.DeepSeekHarness(options);

declare const sdkReasoningEffort: llm.ReasoningEffortId;
declare const boundaryReasoningEffort: BoundaryReasoningEffortId;
const reasoningEffortBoundary: BoundaryReasoningEffortId = sdkReasoningEffort;
const reasoningEffortSdk: llm.ReasoningEffortId = boundaryReasoningEffort;
declare const sdkNotification: sdk.HarnessNotification;
declare const boundaryNotification: HarnessNotification;
declare const sdkRunResult: sdk.RunResult;
const notificationBoundary: HarnessNotification = sdkNotification;
const notificationSdk: sdk.HarnessNotification = boundaryNotification;
const runResultBoundary: DeepSeekHarnessRunResult = sdkRunResult;

void [
  sdkBoundary,
  llmBoundary,
  optionsBoundary,
  optionsSdk,
  harness,
  reasoningEffortBoundary,
  reasoningEffortSdk,
  notificationBoundary,
  notificationSdk,
  runResultBoundary,
];
