/**
 * Workflow execution logic
 */

import { readFileSync } from 'node:fs';
import { WorkflowEngine, type IterationLimitRequest, type UserInputRequest } from '../../../core/workflow/index.js';
import type { WorkflowConfig } from '../../../core/models/index.js';
import type { WorkflowExecutionResult, WorkflowExecutionOptions } from './types.js';
import { callAiJudge, detectRuleIndex, interruptAllQueries } from '../../../infra/claude/index.js';

export type { WorkflowExecutionResult, WorkflowExecutionOptions };

import {
  loadAgentSessions,
  updateAgentSession,
  loadWorktreeSessions,
  updateWorktreeSession,
  loadGlobalConfig,
} from '../../../infra/config/index.js';
import { isQuietMode } from '../../../shared/context.js';
import {
  header,
  info,
  warn,
  error,
  success,
  status,
  blankLine,
  StreamDisplay,
} from '../../../shared/ui/index.js';
import {
  generateSessionId,
  createSessionLog,
  finalizeSessionLog,
  updateLatestPointer,
  initNdjsonLog,
  appendNdjsonLine,
  type NdjsonStepStart,
  type NdjsonStepComplete,
  type NdjsonWorkflowComplete,
  type NdjsonWorkflowAbort,
} from '../../../infra/fs/index.js';
import { createLogger, notifySuccess, notifyError } from '../../../shared/utils/index.js';
import { selectOption, promptInput } from '../../../shared/prompt/index.js';
import { EXIT_SIGINT } from '../../../shared/exitCodes.js';
import { getPrompt } from '../../../shared/prompts/index.js';

const log = createLogger('workflow');

/**
 * Format elapsed time in human-readable format
 */
function formatElapsedTime(startTime: string, endTime: string): string {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  const elapsedMs = end - start;
  const elapsedSec = elapsedMs / 1000;

  if (elapsedSec < 60) {
    return `${elapsedSec.toFixed(1)}s`;
  }

  const minutes = Math.floor(elapsedSec / 60);
  const seconds = Math.floor(elapsedSec % 60);
  return `${minutes}m ${seconds}s`;
}

/**
 * Execute a workflow and handle all events
 */
export async function executeWorkflow(
  workflowConfig: WorkflowConfig,
  task: string,
  cwd: string,
  options: WorkflowExecutionOptions
): Promise<WorkflowExecutionResult> {
  const {
    headerPrefix = 'Running Workflow:',
    interactiveUserInput = false,
  } = options;

  // projectCwd is where .takt/ lives (project root, not the clone)
  const projectCwd = options.projectCwd;

  // Always continue from previous sessions (use /clear to reset)
  log.debug('Continuing session (use /clear to reset)');

  header(`${headerPrefix} ${workflowConfig.name}`);

  const workflowSessionId = generateSessionId();
  let sessionLog = createSessionLog(task, projectCwd, workflowConfig.name);

  // Initialize NDJSON log file + pointer at workflow start
  const ndjsonLogPath = initNdjsonLog(workflowSessionId, task, workflowConfig.name, projectCwd);
  updateLatestPointer(sessionLog, workflowSessionId, projectCwd, { copyToPrevious: true });

  // Track current display for streaming
  const displayRef: { current: StreamDisplay | null } = { current: null };

  // Create stream handler that delegates to UI display
  const streamHandler = (
    event: Parameters<ReturnType<StreamDisplay['createHandler']>>[0]
  ): void => {
    if (!displayRef.current) return;
    if (event.type === 'result') return;
    displayRef.current.createHandler()(event);
  };

  // Load saved agent sessions for continuity (from project root or clone-specific storage)
  const isWorktree = cwd !== projectCwd;
  const currentProvider = loadGlobalConfig().provider ?? 'claude';
  const savedSessions = isWorktree
    ? loadWorktreeSessions(projectCwd, cwd, currentProvider)
    : loadAgentSessions(projectCwd, currentProvider);

  // Session update handler - persist session IDs when they change
  // Clone sessions are stored separately per clone path
  const sessionUpdateHandler = isWorktree
    ? (agentName: string, agentSessionId: string): void => {
        updateWorktreeSession(projectCwd, cwd, agentName, agentSessionId, currentProvider);
      }
    : (agentName: string, agentSessionId: string): void => {
        updateAgentSession(projectCwd, agentName, agentSessionId, currentProvider);
      };

  const iterationLimitHandler = async (
    request: IterationLimitRequest
  ): Promise<number | null> => {
    if (displayRef.current) {
      displayRef.current.flush();
      displayRef.current = null;
    }

    blankLine();
    warn(
      getPrompt('workflow.iterationLimit.maxReached', undefined, {
        currentIteration: String(request.currentIteration),
        maxIterations: String(request.maxIterations),
      })
    );
    info(getPrompt('workflow.iterationLimit.currentStep', undefined, { currentStep: request.currentStep }));

    const action = await selectOption(getPrompt('workflow.iterationLimit.continueQuestion'), [
      {
        label: getPrompt('workflow.iterationLimit.continueLabel'),
        value: 'continue',
        description: getPrompt('workflow.iterationLimit.continueDescription'),
      },
      { label: getPrompt('workflow.iterationLimit.stopLabel'), value: 'stop' },
    ]);

    if (action !== 'continue') {
      return null;
    }

    while (true) {
      const input = await promptInput(getPrompt('workflow.iterationLimit.inputPrompt'));
      if (!input) {
        return null;
      }

      const additionalIterations = Number.parseInt(input, 10);
      if (Number.isInteger(additionalIterations) && additionalIterations > 0) {
        workflowConfig.maxIterations += additionalIterations;
        return additionalIterations;
      }

      warn(getPrompt('workflow.iterationLimit.invalidInput'));
    }
  };

  const onUserInput = interactiveUserInput
    ? async (request: UserInputRequest): Promise<string | null> => {
        if (displayRef.current) {
          displayRef.current.flush();
          displayRef.current = null;
        }
        blankLine();
        info(request.prompt.trim());
        const input = await promptInput(getPrompt('workflow.iterationLimit.userInputPrompt'));
        return input && input.trim() ? input.trim() : null;
      }
    : undefined;

  const engine = new WorkflowEngine(workflowConfig, cwd, task, {
    onStream: streamHandler,
    onUserInput,
    initialSessions: savedSessions,
    onSessionUpdate: sessionUpdateHandler,
    onIterationLimit: iterationLimitHandler,
    projectCwd,
    language: options.language,
    provider: options.provider,
    model: options.model,
    interactive: interactiveUserInput,
    detectRuleIndex,
    callAiJudge,
  });

  let abortReason: string | undefined;

  engine.on('step:start', (step, iteration, instruction) => {
    log.debug('Step starting', { step: step.name, agent: step.agentDisplayName, iteration });
    info(`[${iteration}/${workflowConfig.maxIterations}] ${step.name} (${step.agentDisplayName})`);

    // Log prompt content for debugging
    if (instruction) {
      log.debug('Step instruction', instruction);
    }

    // Use quiet mode from CLI (already resolved CLI flag + config in preAction)
    displayRef.current = new StreamDisplay(step.agentDisplayName, isQuietMode());

    // Write step_start record to NDJSON log
    const record: NdjsonStepStart = {
      type: 'step_start',
      step: step.name,
      agent: step.agentDisplayName,
      iteration,
      timestamp: new Date().toISOString(),
      ...(instruction ? { instruction } : {}),
    };
    appendNdjsonLine(ndjsonLogPath, record);

  });

  engine.on('step:complete', (step, response, instruction) => {
    log.debug('Step completed', {
      step: step.name,
      status: response.status,
      matchedRuleIndex: response.matchedRuleIndex,
      matchedRuleMethod: response.matchedRuleMethod,
      contentLength: response.content.length,
      sessionId: response.sessionId,
      error: response.error,
    });
    if (displayRef.current) {
      displayRef.current.flush();
      displayRef.current = null;
    }
    blankLine();

    if (response.matchedRuleIndex != null && step.rules) {
      const rule = step.rules[response.matchedRuleIndex];
      if (rule) {
        const methodLabel = response.matchedRuleMethod ? ` (${response.matchedRuleMethod})` : '';
        status('Status', `${rule.condition}${methodLabel}`);
      } else {
        status('Status', response.status);
      }
    } else {
      status('Status', response.status);
    }

    if (response.error) {
      error(`Error: ${response.error}`);
    }
    if (response.sessionId) {
      status('Session', response.sessionId);
    }

    // Write step_complete record to NDJSON log
    const record: NdjsonStepComplete = {
      type: 'step_complete',
      step: step.name,
      agent: response.agent,
      status: response.status,
      content: response.content,
      instruction,
      ...(response.matchedRuleIndex != null ? { matchedRuleIndex: response.matchedRuleIndex } : {}),
      ...(response.matchedRuleMethod ? { matchedRuleMethod: response.matchedRuleMethod } : {}),
      ...(response.error ? { error: response.error } : {}),
      timestamp: response.timestamp.toISOString(),
    };
    appendNdjsonLine(ndjsonLogPath, record);


    // Update in-memory log for pointer metadata (immutable)
    sessionLog = { ...sessionLog, iterations: sessionLog.iterations + 1 };
    updateLatestPointer(sessionLog, workflowSessionId, projectCwd);
  });

  engine.on('step:report', (_step, filePath, fileName) => {
    const content = readFileSync(filePath, 'utf-8');
    console.log(`\n📄 Report: ${fileName}\n`);
    console.log(content);
  });

  engine.on('workflow:complete', (state) => {
    log.info('Workflow completed successfully', { iterations: state.iteration });
    sessionLog = finalizeSessionLog(sessionLog, 'completed');

    // Write workflow_complete record to NDJSON log
    const record: NdjsonWorkflowComplete = {
      type: 'workflow_complete',
      iterations: state.iteration,
      endTime: new Date().toISOString(),
    };
    appendNdjsonLine(ndjsonLogPath, record);
    updateLatestPointer(sessionLog, workflowSessionId, projectCwd);

    const elapsed = sessionLog.endTime
      ? formatElapsedTime(sessionLog.startTime, sessionLog.endTime)
      : '';
    const elapsedDisplay = elapsed ? `, ${elapsed}` : '';

    success(`Workflow completed (${state.iteration} iterations${elapsedDisplay})`);
    info(`Session log: ${ndjsonLogPath}`);
    notifySuccess('TAKT', getPrompt('workflow.notifyComplete', undefined, { iteration: String(state.iteration) }));
  });

  engine.on('workflow:abort', (state, reason) => {
    interruptAllQueries();
    log.error('Workflow aborted', { reason, iterations: state.iteration });
    if (displayRef.current) {
      displayRef.current.flush();
      displayRef.current = null;
    }
    abortReason = reason;
    sessionLog = finalizeSessionLog(sessionLog, 'aborted');

    // Write workflow_abort record to NDJSON log
    const record: NdjsonWorkflowAbort = {
      type: 'workflow_abort',
      iterations: state.iteration,
      reason,
      endTime: new Date().toISOString(),
    };
    appendNdjsonLine(ndjsonLogPath, record);
    updateLatestPointer(sessionLog, workflowSessionId, projectCwd);

    const elapsed = sessionLog.endTime
      ? formatElapsedTime(sessionLog.startTime, sessionLog.endTime)
      : '';
    const elapsedDisplay = elapsed ? ` (${elapsed})` : '';

    error(`Workflow aborted after ${state.iteration} iterations${elapsedDisplay}: ${reason}`);
    info(`Session log: ${ndjsonLogPath}`);
    notifyError('TAKT', getPrompt('workflow.notifyAbort', undefined, { reason }));
  });

  // SIGINT handler: 1st Ctrl+C = graceful abort, 2nd = force exit
  let sigintCount = 0;
  const onSigInt = () => {
    sigintCount++;
    if (sigintCount === 1) {
      blankLine();
      warn(getPrompt('workflow.sigintGraceful'));
      engine.abort();
    } else {
      blankLine();
      error(getPrompt('workflow.sigintForce'));
      process.exit(EXIT_SIGINT);
    }
  };
  process.on('SIGINT', onSigInt);

  try {
    const finalState = await engine.run();

    return {
      success: finalState.status === 'completed',
      reason: abortReason,
    };
  } finally {
    process.removeListener('SIGINT', onSigInt);
  }
}
