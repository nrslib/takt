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
import { detectRuleIndex, callAiJudge } from '../claude/client.js';
import { buildInstruction as buildInstructionFromTemplate, buildReportInstruction as buildReportInstructionFromTemplate, isReportObjectConfig } from './instruction-builder.js';
import { LoopDetector } from './loop-detector.js';
import { handleBlocked } from './blocked-handler.js';
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
    this.reportDir = generateReportDir(task);
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
    const reportDirPath = join(this.projectCwd, '.takt', 'reports', this.reportDir);
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
          if (!stepNames.has(rule.next)) {
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
    const baseDir = join(this.projectCwd, '.takt', 'reports', this.reportDir);

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

  /** Build RunAgentOptions from a step's configuration */
  private buildAgentOptions(step: WorkflowStep): RunAgentOptions {
    // Phase 1: exclude Write from allowedTools when step has report config
    const allowedTools = step.report
      ? step.allowedTools?.filter((t) => t !== 'Write')
      : step.allowedTools;

    return {
      cwd: this.cwd,
      sessionId: this.state.agentSessions.get(step.agent),
      agentPath: step.agentPath,
      allowedTools,
      provider: step.provider,
      model: step.model,
      permissionMode: step.permissionMode,
      onStream: this.options.onStream,
      onPermissionRequest: this.options.onPermissionRequest,
      onAskUserQuestion: this.options.onAskUserQuestion,
      bypassPermissions: this.options.bypassPermissions,
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

  /**
   * Detect matched rule for a step's response.
   * 1. Try standard [STEP:N] tag detection
   * 2. Fallback to ai() condition evaluation via AI judge
   */
  private async detectMatchedRule(step: WorkflowStep, content: string): Promise<number | undefined> {
    if (!step.rules || step.rules.length === 0) return undefined;

    const ruleIndex = detectRuleIndex(content, step.name);
    if (ruleIndex >= 0 && ruleIndex < step.rules.length) {
      return ruleIndex;
    }

    const aiRuleIndex = await this.evaluateAiConditions(step, content);
    if (aiRuleIndex >= 0) {
      return aiRuleIndex;
    }

    return undefined;
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

    // Phase 2: report output (resume same session, Write only)
    if (step.report) {
      await this.runReportPhase(step, stepIteration);
    }

    // Status detection uses phase 1 response
    const matchedRuleIndex = await this.detectMatchedRule(step, response.content);
    if (matchedRuleIndex != null) {
      response = { ...response, matchedRuleIndex };
    }

    this.state.stepOutputs.set(step.name, response);
    this.emitStepReports(step);
    return { response, instruction };
  }

  /**
   * Phase 2: Report output.
   * Resumes the agent session with Write-only tools to output reports.
   * The response is discarded — only sessionId is updated.
   */
  private async runReportPhase(step: WorkflowStep, stepIteration: number): Promise<void> {
    const sessionId = this.state.agentSessions.get(step.agent);
    if (!sessionId) {
      log.debug('Skipping report phase: no sessionId to resume', { step: step.name });
      return;
    }

    log.debug('Running report phase', { step: step.name, sessionId });

    const reportInstruction = buildReportInstructionFromTemplate(step, {
      cwd: this.cwd,
      reportDir: this.reportDir,
      stepIteration,
      language: this.language,
    });

    const reportOptions: RunAgentOptions = {
      cwd: this.cwd,
      sessionId,
      agentPath: step.agentPath,
      allowedTools: ['Write'],
      maxTurns: 3,
      provider: step.provider,
      model: step.model,
      permissionMode: step.permissionMode,
      onStream: this.options.onStream,
      onPermissionRequest: this.options.onPermissionRequest,
      onAskUserQuestion: this.options.onAskUserQuestion,
      bypassPermissions: this.options.bypassPermissions,
    };

    const reportResponse = await runAgent(step.agent, reportInstruction, reportOptions);

    // Update session (phase 2 may update it)
    this.updateAgentSession(step.agent, reportResponse.sessionId);

    log.debug('Report phase complete', { step: step.name, status: reportResponse.status });
  }

  /**
   * Run a parallel step: execute all sub-steps concurrently, then aggregate results.
   * The aggregated output becomes the parent step's response for rules evaluation.
   */
  private async runParallelStep(step: WorkflowStep): Promise<{ response: AgentResponse; instruction: string }> {
    const subSteps = step.parallel!;
    const stepIteration = incrementStepIteration(this.state, step.name);
    log.debug('Running parallel step', {
      step: step.name,
      subSteps: subSteps.map(s => s.name),
      stepIteration,
    });

    // Run all sub-steps concurrently
    const subResults = await Promise.all(
      subSteps.map(async (subStep) => {
        const subIteration = incrementStepIteration(this.state, subStep.name);
        const subInstruction = this.buildInstruction(subStep, subIteration);

        // Phase 1: main execution (Write excluded if sub-step has report)
        const agentOptions = this.buildAgentOptions(subStep);
        const subResponse = await runAgent(subStep.agent, subInstruction, agentOptions);
        this.updateAgentSession(subStep.agent, subResponse.sessionId);

        // Phase 2: report output for sub-step
        if (subStep.report) {
          await this.runReportPhase(subStep, subIteration);
        }

        // Detect sub-step rule matches (tag detection + ai() fallback)
        const matchedRuleIndex = await this.detectMatchedRule(subStep, subResponse.content);
        const finalResponse = matchedRuleIndex != null
          ? { ...subResponse, matchedRuleIndex }
          : subResponse;

        this.state.stepOutputs.set(subStep.name, finalResponse);
        this.emitStepReports(subStep);

        return { subStep, response: finalResponse, instruction: subInstruction };
      }),
    );

    // Aggregate sub-step outputs into parent step's response
    const aggregatedContent = subResults
      .map((r) => `## ${r.subStep.name}\n${r.response.content}`)
      .join('\n\n---\n\n');

    const aggregatedInstruction = subResults
      .map((r) => r.instruction)
      .join('\n\n');

    // Evaluate parent step's rules against aggregated output
    const matchedRuleIndex = await this.detectMatchedRule(step, aggregatedContent);

    const aggregatedResponse: AgentResponse = {
      agent: step.name,
      status: 'done',
      content: aggregatedContent,
      timestamp: new Date(),
      ...(matchedRuleIndex != null && { matchedRuleIndex }),
    };

    this.state.stepOutputs.set(step.name, aggregatedResponse);
    this.emitStepReports(step);
    return { response: aggregatedResponse, instruction: aggregatedInstruction };
  }

  /**
   * Evaluate ai() conditions via AI judge.
   * Collects all ai() rules, calls the judge, and maps the result back to the original rule index.
   * Returns the 0-based rule index in the step's rules array, or -1 if no match.
   */
  private async evaluateAiConditions(step: WorkflowStep, agentOutput: string): Promise<number> {
    if (!step.rules) return -1;

    const aiConditions: { index: number; text: string }[] = [];
    for (let i = 0; i < step.rules.length; i++) {
      const rule = step.rules[i]!;
      if (rule.isAiCondition && rule.aiConditionText) {
        aiConditions.push({ index: i, text: rule.aiConditionText });
      }
    }

    if (aiConditions.length === 0) return -1;

    log.debug('Evaluating ai() conditions via judge', {
      step: step.name,
      conditionCount: aiConditions.length,
    });

    // Remap: judge returns 0-based index within aiConditions array
    const judgeConditions = aiConditions.map((c, i) => ({ index: i, text: c.text }));
    const judgeResult = await callAiJudge(agentOutput, judgeConditions, { cwd: this.cwd });

    if (judgeResult >= 0 && judgeResult < aiConditions.length) {
      const matched = aiConditions[judgeResult]!;
      log.debug('AI judge matched condition', {
        step: step.name,
        judgeResult,
        originalRuleIndex: matched.index,
        condition: matched.text,
      });
      return matched.index;
    }

    log.debug('AI judge did not match any condition', { step: step.name });
    return -1;
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
