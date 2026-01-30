/**
 * Workflow execution engine
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  WorkflowConfig,
  WorkflowState,
  WorkflowStep,
  AgentResponse,
} from '../models/types.js';
import { runAgent, type RunAgentOptions } from '../agents/runner.js';
import { COMPLETE_STEP, ABORT_STEP, ERROR_MESSAGES } from './constants.js';
import type { WorkflowEngineOptions } from './types.js';
import { determineNextStepByRules } from './transitions.js';
import { buildInstruction as buildInstructionFromTemplate, isReportObjectConfig } from './instruction-builder.js';
import { LoopDetector } from './loop-detector.js';
import { handleBlocked } from './blocked-handler.js';
import { ParallelLogger } from './parallel-logger.js';
import { detectMatchedRule } from './rule-evaluator.js';
import { needsStatusJudgmentPhase, runReportPhase, runStatusJudgmentPhase } from './phase-runner.js';
import {
  createInitialState,
  addUserInput,
  getPreviousOutput,
  incrementStepIteration,
} from './state-manager.js';
import { generateReportDir } from '../utils/session.js';
import { createLogger } from '../utils/debug.js';

const log = createLogger('engine');

// Re-export types for backward compatibility
export type {
  WorkflowEvents,
  UserInputRequest,
  IterationLimitRequest,
  SessionUpdateCallback,
  IterationLimitCallback,
  WorkflowEngineOptions,
} from './types.js';
export { COMPLETE_STEP, ABORT_STEP } from './constants.js';

/** Workflow engine for orchestrating agent execution */
export class WorkflowEngine extends EventEmitter {
  private state: WorkflowState;
  private config: WorkflowConfig;
  private projectCwd: string;
  private cwd: string;
  private task: string;
  private options: WorkflowEngineOptions;
  private loopDetector: LoopDetector;
  private language: WorkflowEngineOptions['language'];
  private reportDir: string;

  constructor(config: WorkflowConfig, cwd: string, task: string, options: WorkflowEngineOptions = {}) {
    super();
    this.config = config;
    this.projectCwd = options.projectCwd ?? cwd;
    this.cwd = cwd;
    this.task = task;
    this.options = options;
    this.language = options.language;
    this.loopDetector = new LoopDetector(config.loopDetection);
    this.reportDir = `.takt/reports/${generateReportDir(task)}`;
    this.ensureReportDirExists();
    this.validateConfig();
    this.state = createInitialState(config, options);
    log.debug('WorkflowEngine initialized', {
      workflow: config.name,
      steps: config.steps.map(s => s.name),
      initialStep: config.initialStep,
      maxIterations: config.maxIterations,
    });
  }

  /** Ensure report directory exists (always in project root, not clone) */
  private ensureReportDirExists(): void {
    const reportDirPath = join(this.projectCwd, this.reportDir);
    if (!existsSync(reportDirPath)) {
      mkdirSync(reportDirPath, { recursive: true });
    }

    // Worktree mode: create symlink so agents can access reports via relative path
    if (this.cwd !== this.projectCwd) {
      const cwdReportsDir = join(this.cwd, '.takt', 'reports');
      if (!existsSync(cwdReportsDir)) {
        mkdirSync(join(this.cwd, '.takt'), { recursive: true });
        symlinkSync(
          join(this.projectCwd, '.takt', 'reports'),
          cwdReportsDir,
        );
      }
    }
  }

  /** Validate workflow configuration at construction time */
  private validateConfig(): void {
    const initialStep = this.config.steps.find((s) => s.name === this.config.initialStep);
    if (!initialStep) {
      throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(this.config.initialStep));
    }

    const stepNames = new Set(this.config.steps.map((s) => s.name));
    stepNames.add(COMPLETE_STEP);
    stepNames.add(ABORT_STEP);

    for (const step of this.config.steps) {
      if (step.rules) {
        for (const rule of step.rules) {
          if (rule.next && !stepNames.has(rule.next)) {
            throw new Error(
              `Invalid rule in step "${step.name}": target step "${rule.next}" does not exist`
            );
          }
        }
      }
    }
  }

  /** Get current workflow state */
  getState(): WorkflowState {
    return { ...this.state };
  }

  /** Add user input */
  addUserInput(input: string): void {
    addUserInput(this.state, input);
  }

  /** Update working directory */
  updateCwd(newCwd: string): void {
    this.cwd = newCwd;
  }

  /** Get current working directory */
  getCwd(): string {
    return this.cwd;
  }

  /** Get project root directory (where .takt/ lives) */
  getProjectCwd(): string {
    return this.projectCwd;
  }

  /** Build instruction from template */
  private buildInstruction(step: WorkflowStep, stepIteration: number): string {
    return buildInstructionFromTemplate(step, {
      task: this.task,
      iteration: this.state.iteration,
      maxIterations: this.config.maxIterations,
      stepIteration,
      cwd: this.cwd,
      projectCwd: this.projectCwd,
      userInputs: this.state.userInputs,
      previousOutput: getPreviousOutput(this.state),
      reportDir: this.reportDir,
      language: this.language,
    });
  }

  /** Get step by name */
  private getStep(name: string): WorkflowStep {
    const step = this.config.steps.find((s) => s.name === name);
    if (!step) {
      throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(name));
    }
    return step;
  }

  /**
   * Emit step:report events for each report file that exists after step completion.
   * The UI layer (workflowExecution.ts) listens and displays the content.
   */
  private emitStepReports(step: WorkflowStep): void {
    if (!step.report || !this.reportDir) return;
    const baseDir = join(this.projectCwd, this.reportDir);

    if (typeof step.report === 'string') {
      this.emitIfReportExists(step, baseDir, step.report);
    } else if (isReportObjectConfig(step.report)) {
      this.emitIfReportExists(step, baseDir, step.report.name);
    } else {
      // ReportConfig[] (array)
      for (const rc of step.report) {
        this.emitIfReportExists(step, baseDir, rc.path);
      }
    }
  }

  /** Emit step:report if the report file exists */
  private emitIfReportExists(step: WorkflowStep, baseDir: string, fileName: string): void {
    const filePath = join(baseDir, fileName);
    if (existsSync(filePath)) {
      this.emit('step:report', step, filePath, fileName);
    }
  }

  /** Run a single step (delegates to runParallelStep if step has parallel sub-steps) */
  private async runStep(step: WorkflowStep): Promise<{ response: AgentResponse; instruction: string }> {
    if (step.parallel && step.parallel.length > 0) {
      return this.runParallelStep(step);
    }
    return this.runNormalStep(step);
  }

  /** Build common RunAgentOptions shared by all phases */
  private buildBaseOptions(step: WorkflowStep): RunAgentOptions {
    return {
      cwd: this.cwd,
      agentPath: step.agentPath,
      provider: step.provider,
      model: step.model,
      permissionMode: step.permissionMode,
      onStream: this.options.onStream,
      onPermissionRequest: this.options.onPermissionRequest,
      onAskUserQuestion: this.options.onAskUserQuestion,
      bypassPermissions: this.options.bypassPermissions,
    };
  }

  /** Build RunAgentOptions from a step's configuration (Phase 1) */
  private buildAgentOptions(step: WorkflowStep): RunAgentOptions {
    // Phase 1: exclude Write from allowedTools when step has report config
    const allowedTools = step.report
      ? step.allowedTools?.filter((t) => t !== 'Write')
      : step.allowedTools;

    return {
      ...this.buildBaseOptions(step),
      sessionId: this.state.agentSessions.get(step.agent),
      allowedTools,
    };
  }

  /**
   * Build RunAgentOptions for session-resume phases (Phase 2, Phase 3).
   */
  private buildResumeOptions(step: WorkflowStep, sessionId: string, overrides: Pick<RunAgentOptions, 'allowedTools' | 'maxTurns'>): RunAgentOptions {
    return {
      ...this.buildBaseOptions(step),
      sessionId,
      allowedTools: overrides.allowedTools,
      maxTurns: overrides.maxTurns,
    };
  }

  /** Update agent session and notify via callback if session changed */
  private updateAgentSession(agent: string, sessionId: string | undefined): void {
    if (!sessionId) return;

    const previousSessionId = this.state.agentSessions.get(agent);
    this.state.agentSessions.set(agent, sessionId);

    if (this.options.onSessionUpdate && sessionId !== previousSessionId) {
      this.options.onSessionUpdate(agent, sessionId);
    }
  }

  /** Build phase runner context for Phase 2/3 execution */
  private buildPhaseRunnerContext() {
    return {
      cwd: this.cwd,
      reportDir: this.reportDir,
      language: this.language,
      getSessionId: (agent: string) => this.state.agentSessions.get(agent),
      buildResumeOptions: this.buildResumeOptions.bind(this),
      updateAgentSession: this.updateAgentSession.bind(this),
    };
  }

  /** Run a normal (non-parallel) step */
  private async runNormalStep(step: WorkflowStep): Promise<{ response: AgentResponse; instruction: string }> {
    const stepIteration = incrementStepIteration(this.state, step.name);
    const instruction = this.buildInstruction(step, stepIteration);
    log.debug('Running step', {
      step: step.name,
      agent: step.agent,
      stepIteration,
      iteration: this.state.iteration,
      sessionId: this.state.agentSessions.get(step.agent) ?? 'new',
    });

    // Phase 1: main execution (Write excluded if step has report)
    const agentOptions = this.buildAgentOptions(step);
    let response = await runAgent(step.agent, instruction, agentOptions);
    this.updateAgentSession(step.agent, response.sessionId);

    const phaseCtx = this.buildPhaseRunnerContext();

    // Phase 2: report output (resume same session, Write only)
    if (step.report) {
      await runReportPhase(step, stepIteration, phaseCtx);
    }

    // Phase 3: status judgment (resume session, no tools, output status tag)
    let tagContent = '';
    if (needsStatusJudgmentPhase(step)) {
      tagContent = await runStatusJudgmentPhase(step, phaseCtx);
    }

    const match = await detectMatchedRule(step, response.content, tagContent, {
      state: this.state,
      cwd: this.cwd,
    });
    if (match) {
      log.debug('Rule matched', { step: step.name, ruleIndex: match.index, method: match.method });
      response = { ...response, matchedRuleIndex: match.index, matchedRuleMethod: match.method };
    }

    this.state.stepOutputs.set(step.name, response);
    this.emitStepReports(step);
    return { response, instruction };
  }

  /**
   * Run a parallel step: execute all sub-steps concurrently, then aggregate results.
   * The aggregated output becomes the parent step's response for rules evaluation.
   *
   * When onStream is provided, uses ParallelLogger to prefix each sub-step's
   * output with `[name]` for readable interleaved display.
   */
  private async runParallelStep(step: WorkflowStep): Promise<{ response: AgentResponse; instruction: string }> {
    const subSteps = step.parallel!;
    const stepIteration = incrementStepIteration(this.state, step.name);
    log.debug('Running parallel step', {
      step: step.name,
      subSteps: subSteps.map(s => s.name),
      stepIteration,
    });

    // Create parallel logger for prefixed output (only when streaming is enabled)
    const parallelLogger = this.options.onStream
      ? new ParallelLogger({
          subStepNames: subSteps.map((s) => s.name),
          parentOnStream: this.options.onStream,
        })
      : undefined;

    const phaseCtx = this.buildPhaseRunnerContext();
    const ruleCtx = { state: this.state, cwd: this.cwd };

    // Run all sub-steps concurrently
    const subResults = await Promise.all(
      subSteps.map(async (subStep, index) => {
        const subIteration = incrementStepIteration(this.state, subStep.name);
        const subInstruction = this.buildInstruction(subStep, subIteration);

        // Phase 1: main execution (Write excluded if sub-step has report)
        const baseOptions = this.buildAgentOptions(subStep);

        // Override onStream with parallel logger's prefixed handler (immutable)
        const agentOptions = parallelLogger
          ? { ...baseOptions, onStream: parallelLogger.createStreamHandler(subStep.name, index) }
          : baseOptions;

        const subResponse = await runAgent(subStep.agent, subInstruction, agentOptions);
        this.updateAgentSession(subStep.agent, subResponse.sessionId);

        // Phase 2: report output for sub-step
        if (subStep.report) {
          await runReportPhase(subStep, subIteration, phaseCtx);
        }

        // Phase 3: status judgment for sub-step
        let subTagContent = '';
        if (needsStatusJudgmentPhase(subStep)) {
          subTagContent = await runStatusJudgmentPhase(subStep, phaseCtx);
        }

        const match = await detectMatchedRule(subStep, subResponse.content, subTagContent, ruleCtx);
        const finalResponse = match
          ? { ...subResponse, matchedRuleIndex: match.index, matchedRuleMethod: match.method }
          : subResponse;

        this.state.stepOutputs.set(subStep.name, finalResponse);
        this.emitStepReports(subStep);

        return { subStep, response: finalResponse, instruction: subInstruction };
      }),
    );

    // Print completion summary
    if (parallelLogger) {
      parallelLogger.printSummary(
        step.name,
        subResults.map((r) => ({
          name: r.subStep.name,
          condition: r.response.matchedRuleIndex != null && r.subStep.rules
            ? r.subStep.rules[r.response.matchedRuleIndex]?.condition
            : undefined,
        })),
      );
    }

    // Aggregate sub-step outputs into parent step's response
    const aggregatedContent = subResults
      .map((r) => `## ${r.subStep.name}\n${r.response.content}`)
      .join('\n\n---\n\n');

    const aggregatedInstruction = subResults
      .map((r) => r.instruction)
      .join('\n\n');

    // Parent step uses aggregate conditions, so tagContent is empty
    const match = await detectMatchedRule(step, aggregatedContent, '', ruleCtx);

    const aggregatedResponse: AgentResponse = {
      agent: step.name,
      status: 'done',
      content: aggregatedContent,
      timestamp: new Date(),
      ...(match && { matchedRuleIndex: match.index, matchedRuleMethod: match.method }),
    };

    this.state.stepOutputs.set(step.name, aggregatedResponse);
    this.emitStepReports(step);
    return { response: aggregatedResponse, instruction: aggregatedInstruction };
  }

  /**
   * Determine next step for a completed step using rules-based routing.
   */
  private resolveNextStep(step: WorkflowStep, response: AgentResponse): string {
    if (response.matchedRuleIndex != null && step.rules) {
      const nextByRules = determineNextStepByRules(step, response.matchedRuleIndex);
      if (nextByRules) {
        return nextByRules;
      }
    }

    throw new Error(`No matching rule found for step "${step.name}" (status: ${response.status})`);
  }

  /** Run the workflow to completion */
  async run(): Promise<WorkflowState> {
    while (this.state.status === 'running') {
      if (this.state.iteration >= this.config.maxIterations) {
        this.emit('iteration:limit', this.state.iteration, this.config.maxIterations);

        if (this.options.onIterationLimit) {
          const additionalIterations = await this.options.onIterationLimit({
            currentIteration: this.state.iteration,
            maxIterations: this.config.maxIterations,
            currentStep: this.state.currentStep,
          });

          if (additionalIterations !== null && additionalIterations > 0) {
            this.config = {
              ...this.config,
              maxIterations: this.config.maxIterations + additionalIterations,
            };
            continue;
          }
        }

        this.state.status = 'aborted';
        this.emit('workflow:abort', this.state, ERROR_MESSAGES.MAX_ITERATIONS_REACHED);
        break;
      }

      const step = this.getStep(this.state.currentStep);
      const loopCheck = this.loopDetector.check(step.name);

      if (loopCheck.shouldWarn) {
        this.emit('step:loop_detected', step, loopCheck.count);
      }

      if (loopCheck.shouldAbort) {
        this.state.status = 'aborted';
        this.emit('workflow:abort', this.state, ERROR_MESSAGES.LOOP_DETECTED(step.name, loopCheck.count));
        break;
      }

      this.state.iteration++;
      this.emit('step:start', step, this.state.iteration);

      try {
        const { response, instruction } = await this.runStep(step);
        this.emit('step:complete', step, response, instruction);

        if (response.status === 'blocked') {
          this.emit('step:blocked', step, response);
          const result = await handleBlocked(step, response, this.options);

          if (result.shouldContinue && result.userInput) {
            this.addUserInput(result.userInput);
            this.emit('step:user_input', step, result.userInput);
            continue;
          }

          this.state.status = 'aborted';
          this.emit('workflow:abort', this.state, 'Workflow blocked and no user input provided');
          break;
        }

        const nextStep = this.resolveNextStep(step, response);
        log.debug('Step transition', {
          from: step.name,
          status: response.status,
          matchedRuleIndex: response.matchedRuleIndex,
          nextStep,
        });

        if (nextStep === COMPLETE_STEP) {
          this.state.status = 'completed';
          this.emit('workflow:complete', this.state);
          break;
        }

        if (nextStep === ABORT_STEP) {
          this.state.status = 'aborted';
          this.emit('workflow:abort', this.state, 'Workflow aborted by step transition');
          break;
        }

        this.state.currentStep = nextStep;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.state.status = 'aborted';
        this.emit('workflow:abort', this.state, ERROR_MESSAGES.STEP_EXECUTION_FAILED(message));
        break;
      }
    }

    return this.state;
  }

  /** Run a single iteration (for interactive mode) */
  async runSingleIteration(): Promise<{
    response: AgentResponse;
    nextStep: string;
    isComplete: boolean;
    loopDetected?: boolean;
  }> {
    const step = this.getStep(this.state.currentStep);
    const loopCheck = this.loopDetector.check(step.name);

    if (loopCheck.shouldAbort) {
      this.state.status = 'aborted';
      return {
        response: {
          agent: step.agent,
          status: 'blocked',
          content: ERROR_MESSAGES.LOOP_DETECTED(step.name, loopCheck.count),
          timestamp: new Date(),
        },
        nextStep: ABORT_STEP,
        isComplete: true,
        loopDetected: true,
      };
    }

    this.state.iteration++;
    const { response } = await this.runStep(step);
    const nextStep = this.resolveNextStep(step, response);
    const isComplete = nextStep === COMPLETE_STEP || nextStep === ABORT_STEP;

    if (!isComplete) {
      this.state.currentStep = nextStep;
    } else {
      this.state.status = nextStep === COMPLETE_STEP ? 'completed' : 'aborted';
    }

    return { response, nextStep, isComplete, loopDetected: loopCheck.isLoop };
  }
}
