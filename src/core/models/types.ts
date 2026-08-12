/**
 * Core type definitions for TAKT orchestration system
 *
 * This file re-exports all types from categorized sub-modules.
 * Consumers import from './types.js' — no path changes needed.
 */

// Status and classification types
export type {
  AgentType,
  Status,
  RuleMatchMethod,
  PermissionMode,
} from './status.js';

// Agent response
export type {
  AgentErrorKind,
  AgentResponse,
  ProviderUsageSnapshot,
  RateLimitInfo,
} from './response.js';

// Session state (authoritative definition with createSessionState)
export type {
  SessionState,
} from './session.js';

// Part decomposition
export type {
  PartDefinition,
  PartResult,
  TeamLeaderConfig,
} from './part.js';

// Workflow configuration and runtime state
export type {
  WorkflowRule,
  WorkflowMaxSteps,
  WorkflowStructuredOutput,
  WorkflowPrListWhere,
  WorkflowSystemInput,
  WorkflowEffect,
  WorkflowEnqueueBaseBranchConfig,
  WorkflowEnqueueIssueConfig,
  WorkflowEnqueueWorktreeConfig,
  WorkflowTemplateReference,
  WorkflowEffectScalarReference,
  OutputContractItem,
  OutputContractEntry,
  CommandQualityGate,
  QualityGate,
  McpServerConfig,
  RuntimePreparePreset,
  RuntimePrepareEntry,
  WorkflowRuntimeConfig,
  WorkflowStepKind,
  WorkflowResumeFrameKind,
  WorkflowCallOverrides,
  WorkflowSessionMode,
  WorkflowPromotionEntry,
  WorkflowParamType,
  WorkflowParamFacetKind,
  WorkflowCallArgValue,
  WorkflowCallVariableValue,
  WorkflowSubworkflowParamConfig,
  WorkflowSubworkflowConfig,
  WorkflowResumePointEntry,
  WorkflowRestartPointEntry,
  WorkflowRestartPoint,
  WorkflowResumePoint,
  WorkflowCallInvocationRecord,
  WorkflowStepParticipationRecord,
  StepProviderOptions,
  OpenCodeGuardOptions,
  OpenCodeGuardProfile,
  AgentWorkflowStep,
  NormalAgentWorkflowStep,
  ParallelWorkflowStep,
  DynamicParallelFixedSubStep,
  DynamicParallelPoolSubStep,
  DynamicParallelSubSteps,
  DynamicParallelSelectionMode,
  DynamicParallelSelectionSnapshot,
  ParallelSubSteps,
  ArpeggioWorkflowStep,
  TeamLeaderWorkflowStep,
  SystemWorkflowStep,
  WorkflowCallStep,
  WorkflowStep,
  ArpeggioStepConfig,
  ArpeggioMergeStepConfig,
  LoopDetectionConfig,
  LoopMonitorConfig,
  LoopMonitorJudge,
  LoopMonitorRule,
  RateLimitFallbackConfig,
  RateLimitFallbackProvider,
  FallbackContext,
  FallbackOperationStage,
  FallbackOperationOrigin,
  RateLimitFallbackState,
  WorkflowConfig,
  WorkflowState,
  ResolvedFacetPool,
  ResolvedFacetPoolCandidate,
  ResolvedFacetContent,
  DynamicFacetsConfig,
  DynamicFacetSelectionSnapshot,
} from './workflow-types.js';

export type {
  CompanionSelection,
  ResolvedCompanionDefinition,
  CompanionFindingSeverity,
  CompanionFindingStatus,
  CompanionFindingUpdateStatus,
  CompanionFinding,
  CompanionFindingEvidence,
  CompanionWorkflowState,
} from './companion-types.js';

export {
  WORKFLOW_SESSION_MODES,
  OPENCODE_GUARD_PROFILES,
  getAllParallelSubSteps,
  isDynamicParallelSubSteps,
  isNormalAgentWorkflowStep,
} from './workflow-types.js';


// Provider permission profiles
export type {
  ProviderProfileName,
  ProviderPermissionProfile,
  ProviderPermissionProfiles,
} from './provider-profiles.js';

// Configuration types (global and project)
export type {
  PersonaProviderEntry,
  RoutingTier,
  AutoRoutingStrategy,
  AutoRoutingCandidate,
  AutoRoutingConfig,
  ProviderRoutingConfig,
  ProviderRoutingEntry,
  CustomAgentConfig,
  LoggingConfig,
  TelemetryConfig,
  ObservabilityConfig,
  ResolvedObservabilityConfig,
  Language,
  PipelineConfig,
  ProjectConfig,
} from './config-types.js';
