/**
 * Executes a single workflow step through the 3-phase model.
 *
 * Phase 1: Main agent execution (with tools)
 * Phase 2: Report output (Write-only, optional)
 * Phase 3: Status judgment (no tools, optional)
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  WorkflowStep,
  WorkflowState,
  AgentResponse,
  Language,
} from '../../models/types.js';
import type { PhaseName, PhasePromptParts, JudgeStageEntry, RuntimeStepResolution } from '../types.js';
import { executeAgent } from '../../../agents/agent-usecases.js';
import { InstructionBuilder } from '../instruction/InstructionBuilder.js';
import { needsStatusJudgmentPhase, runReportPhase, runStatusJudgmentPhase } from '../phase-runner.js';
import { detectMatchedRule } from '../evaluation/index.js';
import type { StatusJudgmentPhaseResult } from '../phase-runner.js';
import { buildSessionKey } from '../session-key.js';
import { incrementStepIteration, getPreviousOutput } from './state-manager.js';
import { createLogger, getErrorMessage, slugify } from '../../../shared/utils/index.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { RunPaths } from '../run/run-paths.js';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import { waitForStepDelay } from './step-delay.js';
import { parseLastJsonBlock } from '../../../agents/structured-caller/shared.js';
import {
  assertProviderResolvedForCapabilitySensitiveOptions,
} from './engine-provider-options.js';
import { validateStructuredOutputAgainstSchema } from './structured-output-schema-validator.js';
import { providerSupportsStructuredOutput } from '../../../infra/providers/provider-capabilities.js';

const log = createLogger('step-executor');

export interface StepExecutorDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly getCwd: () => string;
  readonly getProjectCwd: () => string;
  readonly getReportDir: () => string;
  readonly getRunPaths: () => RunPaths;
  readonly getLanguage: () => Language | undefined;
  readonly getInteractive: () => boolean;
  readonly getWorkflowSteps: () => ReadonlyArray<{ name: string; description?: string }>;
  readonly getWorkflowName: () => string;
  readonly getWorkflowDescription: () => string | undefined;
  readonly getRetryNote: () => string | undefined;
  readonly detectRuleIndex: (content: string, stepName: string) => number;
  readonly structuredCaller: StructuredCaller;
  readonly onPhaseStart?: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    instruction: string,
    promptParts: PhasePromptParts,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  readonly onPhaseComplete?: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    content: string,
    status: string,
    error?: string,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  readonly onJudgeStage?: (
    step: WorkflowStep,
    phase: 3,
    phaseName: 'judge',
    entry: JudgeStageEntry,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
}

export class StepExecutor {
  constructor(
    private readonly deps: StepExecutorDeps,
  ) {}

  private static buildTimestamp(): string {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  private static buildSnapshotFileName(
    stepName: string,
    stepIteration: number,
    timestamp: string,
  ): string {
    const safeStepName = slugify(stepName) || 'step';
    return `${safeStepName}.${stepIteration}.${timestamp}.md`;
  }

  private writeSnapshot(
    content: string,
    directoryRel: string,
    filename: string,
  ): string {
    const absPath = join(this.deps.getCwd(), directoryRel, filename);
    writeFileSync(absPath, content, 'utf-8');
    return `${directoryRel}/${filename}`;
  }

  private writeFacetSnapshot(
    facet: 'knowledge' | 'policy',
    stepName: string,
    stepIteration: number,
    contents: string[] | undefined,
  ): { content: string[]; sourcePath: string } | undefined {
    if (!contents || contents.length === 0) return undefined;
    const merged = contents.join('\n\n---\n\n');
    const timestamp = StepExecutor.buildTimestamp();
    const runPaths = this.deps.getRunPaths();
    const directoryRel = facet === 'knowledge'
      ? runPaths.contextKnowledgeRel
      : runPaths.contextPolicyRel;
    const sourcePath = this.writeSnapshot(
      merged,
      directoryRel,
      StepExecutor.buildSnapshotFileName(stepName, stepIteration, timestamp),
    );
    return { content: [merged], sourcePath };
  }

  private ensurePreviousResponseSnapshot(
    state: WorkflowState,
    stepName: string,
    stepIteration: number,
  ): void {
    if (!state.lastOutput || state.previousResponseSourcePath) return;
    const timestamp = StepExecutor.buildTimestamp();
    const runPaths = this.deps.getRunPaths();
    const fileName = StepExecutor.buildSnapshotFileName(stepName, stepIteration, timestamp);
    const sourcePath = this.writeSnapshot(
      state.lastOutput.content,
      runPaths.contextPreviousResponsesRel,
      fileName,
    );
    this.writeSnapshot(
      state.lastOutput.content,
      runPaths.contextPreviousResponsesRel,
      'latest.md',
    );
    state.previousResponseSourcePath = sourcePath;
  }

  persistPreviousResponseSnapshot(
    state: WorkflowState,
    stepName: string,
    stepIteration: number,
    content: string,
  ): void {
    const timestamp = StepExecutor.buildTimestamp();
    const runPaths = this.deps.getRunPaths();
    const fileName = StepExecutor.buildSnapshotFileName(stepName, stepIteration, timestamp);
    const sourcePath = this.writeSnapshot(content, runPaths.contextPreviousResponsesRel, fileName);
    this.writeSnapshot(content, runPaths.contextPreviousResponsesRel, 'latest.md');
    state.previousResponseSourcePath = sourcePath;
  }

  buildPhase1Instruction(
    instruction: string,
    step: WorkflowStep,
    runtime?: RuntimeStepResolution,
  ): string {
    const provider = this.deps.optionsBuilder.resolveStepProviderModel(step, runtime).provider;
    assertProviderResolvedForCapabilitySensitiveOptions(provider, {
      stepName: step.name,
      usesStructuredOutput: step.structuredOutput !== undefined,
      usesMcpServers: false,
      usesClaudeAllowedTools: false,
    });
    const supportsStructuredOutput = providerSupportsStructuredOutput(provider);
    if (!step.structuredOutput || supportsStructuredOutput !== false) {
      return instruction;
    }

    return [
      instruction,
      '',
      'Return exactly one fenced JSON block that matches this JSON schema:',
      '```json',
      JSON.stringify(step.structuredOutput.schema, null, 2),
      '```',
      'Do not include any text before or after the JSON block.',
    ].join('\n');
  }

  private normalizeStructuredOutput(
    step: WorkflowStep,
    response: AgentResponse,
    runtime?: RuntimeStepResolution,
  ): AgentResponse {
    if (!step.structuredOutput || response.status !== 'done') {
      return response;
    }

    const provider = this.deps.optionsBuilder.resolveStepProviderModel(step, runtime).provider;
    assertProviderResolvedForCapabilitySensitiveOptions(provider, {
      stepName: step.name,
      usesStructuredOutput: true,
      usesMcpServers: false,
      usesClaudeAllowedTools: false,
    });

    try {
      let structuredOutput = response.structuredOutput;

      if (structuredOutput === undefined) {
        if (providerSupportsStructuredOutput(provider) !== false) {
          throw new Error('Structured output response is missing');
        }

        const parsed = parseLastJsonBlock(response.content);
        if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
          throw new Error('Structured output JSON must be an object');
        }
        structuredOutput = parsed as Record<string, unknown>;
      }

      validateStructuredOutputAgainstSchema(structuredOutput, step.structuredOutput.schema);
      if (structuredOutput === response.structuredOutput) {
        return response;
      }

      return {
        ...response,
        structuredOutput,
      };
    } catch (error) {
      const detail = getErrorMessage(error);
      throw new Error(
        `Step "${step.name}" requires structured_output for provider "${provider ?? 'unknown'}": ${detail}`,
      );
    }
  }

  /** Build Phase 1 instruction from template */
  buildInstruction(
    step: WorkflowStep,
    stepIteration: number,
    state: WorkflowState,
    task: string,
    maxSteps: number,
  ): string {
    this.ensurePreviousResponseSnapshot(state, step.name, stepIteration);
    const policySnapshot = this.writeFacetSnapshot(
      'policy',
      step.name,
      stepIteration,
      step.policyContents,
    );
    const knowledgeSnapshot = this.writeFacetSnapshot(
      'knowledge',
      step.name,
      stepIteration,
      step.knowledgeContents,
    );
    const workflowSteps = this.deps.getWorkflowSteps();
    return new InstructionBuilder(step, {
      task,
      iteration: state.iteration,
      maxSteps,
      stepIteration,
      cwd: this.deps.getCwd(),
      projectCwd: this.deps.getProjectCwd(),
      userInputs: state.userInputs,
      previousOutput: getPreviousOutput(state),
      reportDir: join(this.deps.getCwd(), this.deps.getReportDir()),
      language: this.deps.getLanguage(),
      interactive: this.deps.getInteractive(),
      workflowSteps,
      currentStepIndex: workflowSteps.findIndex(s => s.name === step.name),
      workflowName: this.deps.getWorkflowName(),
      workflowDescription: this.deps.getWorkflowDescription(),
      retryNote: this.deps.getRetryNote(),
      policyContents: policySnapshot?.content ?? step.policyContents,
      policySourcePath: policySnapshot?.sourcePath,
      knowledgeContents: knowledgeSnapshot?.content ?? step.knowledgeContents,
      knowledgeSourcePath: knowledgeSnapshot?.sourcePath,
      previousResponseSourcePath: state.previousResponseSourcePath,
      workflowState: state,
    }).build();
  }

  /**
   * Apply shared post-execution phases (Phase 2/3 + fallback rule evaluation).
   *
   * This method is intentionally reusable by non-normal step runners
   * (e.g., team_leader) so rule/report behavior stays consistent.
   */
  async applyPostExecutionPhases(
    step: WorkflowStep,
    state: WorkflowState,
    stepIteration: number,
    response: AgentResponse,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    runtime?: RuntimeStepResolution,
  ): Promise<AgentResponse> {
    let nextResponse = response;

    if (nextResponse.status === 'error' || nextResponse.status === 'blocked') {
      return nextResponse;
    }

    const phaseCtx = this.deps.optionsBuilder.buildPhaseRunnerContext(
      state,
      nextResponse.content,
      updatePersonaSession,
      this.deps.onPhaseStart,
      this.deps.onPhaseComplete,
      this.deps.onJudgeStage,
      state.iteration,
      runtime,
    );

    // Phase 2: report output (resume same session, Write only)
    // Report generation is only valid after a completed Phase 1 response.
    if (nextResponse.status === 'done' && step.outputContracts && step.outputContracts.length > 0) {
      const reportResult = await runReportPhase(step, stepIteration, phaseCtx);
      if (reportResult?.blocked) {
        nextResponse = { ...nextResponse, status: 'blocked', content: reportResult.response.content };
        return nextResponse;
      }
    }

    if (nextResponse.structuredOutput) {
      state.structuredOutputs.set(step.name, nextResponse.structuredOutput);
    }

    // Phase 3: status judgment (new session, no tools, determines matched rule)
    let phase3Result: StatusJudgmentPhaseResult | undefined;
    try {
      phase3Result = needsStatusJudgmentPhase(step)
        ? await runStatusJudgmentPhase(step, phaseCtx)
        : undefined;
    } catch (error) {
      log.info('Phase 3 status judgment failed, falling back to phase1 rule evaluation', {
        step: step.name,
        error: getErrorMessage(error),
      });
    }

    if (phase3Result) {
      log.debug('Rule matched (Phase 3)', {
        step: step.name,
        ruleIndex: phase3Result.ruleIndex,
        method: phase3Result.method,
      });
      nextResponse = {
        ...nextResponse,
        matchedRuleIndex: phase3Result.ruleIndex,
        matchedRuleMethod: phase3Result.method,
      };
      return nextResponse;
    }

    // No Phase 3 — use rule evaluator with Phase 1 content
    const stepProviderModel = this.deps.optionsBuilder.resolveStepProviderModel(step, runtime);
    const match = await detectMatchedRule(step, nextResponse.content, '', {
      state,
      cwd: this.deps.getCwd(),
      provider: stepProviderModel.provider,
      resolvedProvider: stepProviderModel.provider,
      resolvedModel: stepProviderModel.model,
      interactive: this.deps.getInteractive(),
      detectRuleIndex: this.deps.detectRuleIndex,
      structuredCaller: this.deps.structuredCaller,
    });
    if (match) {
      log.debug('Rule matched', { step: step.name, ruleIndex: match.index, method: match.method });
      nextResponse = {
        ...nextResponse,
        matchedRuleIndex: match.index,
        matchedRuleMethod: match.method,
      };
    }

    return nextResponse;
  }

  /**
   * Execute a normal (non-parallel) step through all 3 phases.
   *
   * Returns the final response (with matchedRuleIndex if a rule matched)
   * and the instruction used for Phase 1.
   */
  async runNormalStep(
    step: WorkflowStep,
    state: WorkflowState,
    task: string,
    maxSteps: number,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    prebuiltInstruction?: string,
    runtime?: RuntimeStepResolution,
  ): Promise<{ response: AgentResponse; instruction: string }> {
    await waitForStepDelay(step);
    const stepIteration = prebuiltInstruction
      ? state.stepIterations.get(step.name) ?? 1
      : incrementStepIteration(state, step.name);
    const instruction = prebuiltInstruction ?? this.buildInstruction(step, stepIteration, state, task, maxSteps);
    const phase1Instruction = this.buildPhase1Instruction(instruction, step, runtime);
    const sessionKey = buildSessionKey(step, runtime?.providerInfo?.provider);
    log.debug('Running step', {
      step: step.name,
      persona: step.persona ?? '(none)',
      stepIteration,
      iteration: state.iteration,
      sessionId: state.personaSessions.get(sessionKey) ?? 'new',
    });

    // Phase 1: main execution (Write excluded if step has report)
    let didEmitPhaseStart = false;
    const baseAgentOptions = this.deps.optionsBuilder.buildAgentOptions(step, runtime);
    const agentOptions = {
      ...baseAgentOptions,
      onPromptResolved: (promptParts: PhasePromptParts) => {
        this.deps.onPhaseStart?.(step, 1, 'execute', phase1Instruction, promptParts, undefined, state.iteration);
        didEmitPhaseStart = true;
      },
    };
    let response = await executeAgent(step.persona, phase1Instruction, agentOptions);
    response = this.normalizeStructuredOutput(step, response, runtime);
    if (!didEmitPhaseStart) {
      throw new Error(`Missing prompt parts for phase start: ${step.name}:1`);
    }
    updatePersonaSession(sessionKey, response.sessionId);
    this.deps.onPhaseComplete?.(step, 1, 'execute', response.content, response.status, response.error, undefined, state.iteration);

    // Provider failures should abort immediately.
    if (response.status === 'error') {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      return { response, instruction: phase1Instruction };
    }

    // Blocked responses should be handled by WorkflowEngine's blocked flow.
    // Persist snapshot so re-execution receives the latest blocked context.
    if (response.status === 'blocked') {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      this.persistPreviousResponseSnapshot(state, step.name, stepIteration, response.content);
      return { response, instruction: phase1Instruction };
    }

    response = await this.applyPostExecutionPhases(
      step,
      state,
      stepIteration,
      response,
      updatePersonaSession,
      runtime,
    );

    state.stepOutputs.set(step.name, response);
    state.lastOutput = response;
    this.persistPreviousResponseSnapshot(state, step.name, stepIteration, response.content);
    this.emitStepReports(step);
    return { response, instruction: phase1Instruction };
  }

  /** Collect step:report events for each report file that exists */
  emitStepReports(step: WorkflowStep): void {
    if (!step.outputContracts || step.outputContracts.length === 0) return;
    const baseDir = join(this.deps.getCwd(), this.deps.getReportDir());

    for (const entry of step.outputContracts) {
      const fileName = entry.name;
      this.checkReportFile(step, baseDir, fileName);
    }
  }

  // Collects report file paths that exist (used by WorkflowEngine to emit events)
  private reportFiles: Array<{ step: WorkflowStep; filePath: string; fileName: string }> = [];

  /** Check if report file exists and collect for emission */
  private checkReportFile(step: WorkflowStep, baseDir: string, fileName: string): void {
    const filePath = join(baseDir, fileName);
    if (existsSync(filePath)) {
      this.reportFiles.push({ step, filePath, fileName });
    }
  }

  /** Drain collected report files (called by engine after step execution) */
  drainReportFiles(): Array<{ step: WorkflowStep; filePath: string; fileName: string }> {
    const files = this.reportFiles;
    this.reportFiles = [];
    return files;
  }

}
