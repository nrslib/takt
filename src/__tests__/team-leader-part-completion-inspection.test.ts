import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse, PartDefinition, WorkflowStep } from '../core/models/types.js';
import type {
  FindingContractControlValidationIssue,
} from '../core/workflow/team-leader-finding-contract-control-validation.js';
import type { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import type { StepExecutor } from '../core/workflow/engine/StepExecutor.js';
import {
  buildSessionlessPartCompletionInspectionOptions,
} from '../core/workflow/engine/team-leader-part-completion-inspection.js';
import {
  requestTeamLeaderPartCompletionCorrection,
} from '../core/workflow/engine/team-leader-part-runner.js';
import {
  validateOrRecoverFindingContractPartCompletion,
} from '../core/workflow/engine/team-leader-finding-contract-part-completion-recovery.js';
import type {
  TeamLeaderExecutionTerminalState,
} from '../core/workflow/engine/team-leader-execution-terminal.js';

const { executeAgentMock } = vi.hoisted(() => ({ executeAgentMock: vi.fn() }));
const { requestCorrectionMock } = vi.hoisted(() => ({
  requestCorrectionMock: vi.fn(),
}));

// Delegates to the actual implementation by default so the inspection tests
// below keep exercising the real correction path; the recovery describe
// overrides it per test with mockResolvedValueOnce/mockImplementationOnce.
vi.mock('../core/workflow/engine/team-leader-part-runner.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../core/workflow/engine/team-leader-part-runner.js')
  >();
  requestCorrectionMock.mockImplementation(actual.requestTeamLeaderPartCompletionCorrection);
  return {
    ...actual,
    requestTeamLeaderPartCompletionCorrection: requestCorrectionMock,
  };
});

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: executeAgentMock,
}));

const temporaryDirectories: string[] = [];

const fileLineIssue: FindingContractControlValidationIssue = {
  boundaryKind: 'part_completion',
  code: 'evidence.disputed_file_line',
  category: 'evidence',
  path: 'findingOutcomes[0].evidence',
  message: 'file:line evidence is required',
  findingId: 'F-0001',
  partId: 'repair',
  retryability: 'corrective_retry',
};

const summaryIssue: FindingContractControlValidationIssue = {
  boundaryKind: 'part_completion',
  code: 'shape.summary',
  category: 'shape',
  path: 'summary',
  message: 'summary must be a non-empty string',
  partId: 'repair',
  retryability: 'corrective_retry',
};

const part: PartDefinition = {
  id: 'repair',
  title: 'Repair',
  instruction: 'repair',
  findingContract: {
    findingIds: ['F-0001'],
    role: 'repair',
    readPaths: ['src/shared', 'src/exact.ts'],
  },
};

const step: WorkflowStep = {
  name: 'fix',
  persona: 'coder',
  personaDisplayName: 'Coder',
  instruction: 'fix',
  teamLeader: {
    mode: 'finding_contract_fix',
    partPersona: 'coder',
  },
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

function createWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-part-inspection-'));
  temporaryDirectories.push(cwd);
  mkdirSync(join(cwd, 'src', 'shared'), { recursive: true });
  mkdirSync(join(cwd, 'src', 'repair'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'shared', 'inside.ts'), 'inside');
  writeFileSync(join(cwd, 'outside.ts'), 'outside');
  return cwd;
}

function partCompletionClaim(
  summary: string,
  outcome: 'addressed' | 'disputed' = 'addressed',
  evidence: string[] = ['src/shared/inside.ts:1'],
) {
  return {
    findingOutcomes: [{
      findingId: 'F-0001',
      outcome,
      evidence,
    }],
    changedPaths: ['src/repair/fix.ts'],
    checks: [{ command: 'npm test', status: 'passed' }],
    summary,
  };
}

function createRecoveryDependencies(cwd: string, provider: 'claude-sdk' | 'codex') {
  const optionsBuilder = {
    buildAgentOptions: vi.fn().mockReturnValue({ cwd, outputSchema: { type: 'object' } }),
    buildNewSessionReportOptions: vi.fn().mockReturnValue({
      cwd,
      resolvedProvider: provider,
      permissionMode: 'readonly',
      allowedTools: [],
    }),
    resolveStepProviderModel: vi.fn().mockReturnValue({
      provider,
      model: provider === 'codex' ? 'gpt-5' : 'claude-sonnet',
    }),
  } as unknown as OptionsBuilder;
  const stepExecutor = {
    normalizeStructuredOutputWithDiagnostics: vi.fn(
      (_step: WorkflowStep, response: unknown) => ({
        response,
        invalidDetail: undefined,
      }),
    ),
  } as unknown as StepExecutor;
  return {
    optionsBuilder,
    stepExecutor,
    language: 'en' as const,
    recordUsage: vi.fn(),
  };
}

describe('sessionless part completion inspection', () => {
  it.each(['claude-sdk', 'mock'] as const)(
    'requires every Read request to pass path validation for %s',
    (provider) => {
      const options = buildSessionlessPartCompletionInspectionOptions(
        '/workspace',
        provider,
        [fileLineIssue],
      );

      expect(options.allowedTools).toEqual([]);
      expect(options.onPermissionRequest).toBeTypeOf('function');
    },
  );

  it('allows only Read calls inside the working directory', async () => {
    const cwd = createWorkspace();
    const options = buildSessionlessPartCompletionInspectionOptions(
      cwd,
      'claude-sdk',
      [fileLineIssue],
    );
    const handler = options.onPermissionRequest;
    if (handler === undefined) throw new Error('Missing inspection permission handler');

    await expect(handler({
      toolName: 'Read',
      input: { file_path: 'src/shared/inside.ts' },
    })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: 'src/shared/inside.ts' },
    });
    await expect(handler({
      toolName: 'Read',
      input: { file_path: join(cwd, 'src', 'repair', 'claim.ts') },
    })).resolves.toEqual(expect.objectContaining({ behavior: 'allow' }));
    await expect(handler({
      toolName: 'Read',
      input: { file_path: 'outside.ts' },
    })).resolves.toEqual(expect.objectContaining({ behavior: 'allow' }));

    for (const request of [
      { toolName: 'Read', input: { file_path: '../outside.ts' } },
      { toolName: 'Edit', input: { file_path: 'src/shared/inside.ts' } },
      { toolName: 'Bash', input: { command: 'npm test' } },
      { toolName: 'Read', input: {} },
    ]) {
      await expect(handler(request)).resolves.toEqual(expect.objectContaining({
        behavior: 'deny',
      }));
    }
  });

  it('denies a symlink that escapes the workspace scope', async () => {
    const cwd = createWorkspace();
    const external = mkdtempSync(join(tmpdir(), 'takt-part-inspection-external-'));
    temporaryDirectories.push(external);
    writeFileSync(join(external, 'secret.ts'), 'secret');
    symlinkSync(external, join(cwd, 'src', 'shared', 'external'));
    const options = buildSessionlessPartCompletionInspectionOptions(
      cwd,
      'claude-sdk',
      [fileLineIssue],
    );
    const handler = options.onPermissionRequest;
    if (handler === undefined) throw new Error('Missing inspection permission handler');

    await expect(handler({
      toolName: 'Read',
      input: { file_path: 'src/shared/external/secret.ts' },
    })).resolves.toEqual(expect.objectContaining({ behavior: 'deny' }));
  });

  it.each([
    'claude',
    'claude-terminal',
    'codex',
    'opencode',
    'cursor',
    'copilot',
    'kiro',
  ] as const)('fails fast for provider %s without path-scoped inspection capability', (provider) => {
    expect(() => buildSessionlessPartCompletionInspectionOptions(
      '/workspace',
      provider,
      [fileLineIssue],
    ))
      .toThrow(`Provider "${provider}" does not support path-scoped sessionless part completion inspection`);
  });

  it('fails fast when inspection is required but the provider is unresolved', () => {
    expect(() => buildSessionlessPartCompletionInspectionOptions(
      '/workspace',
      undefined,
      [fileLineIssue],
    ))
      .toThrow('Sessionless part completion inspection requires a resolved provider');
  });

  it('uses scoped inspection only for a file:line correction in a new session', async () => {
    const cwd = createWorkspace();
    executeAgentMock.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'claim',
      timestamp: new Date(),
    });
    const buildNewSessionReportOptions = vi.fn().mockReturnValue({
      cwd,
      resolvedProvider: 'claude-sdk',
      permissionMode: 'readonly',
      allowedTools: [],
    });
    const buildResumeOptions = vi.fn().mockReturnValue({
      cwd,
      resolvedProvider: 'claude-sdk',
      permissionMode: 'readonly',
      sessionId: 'session-1',
      allowedTools: [],
    });
    const optionsBuilder = {
      buildAgentOptions: vi.fn().mockReturnValue({ cwd, outputSchema: { type: 'object' } }),
      buildNewSessionReportOptions,
      buildResumeOptions,
    } as unknown as OptionsBuilder;

    await requestTeamLeaderPartCompletionCorrection(
      optionsBuilder,
      step,
      part,
      'correct the claim',
      undefined,
      new AbortController().signal,
      [fileLineIssue],
    );

    const sessionlessOptions = executeAgentMock.mock.calls[0]?.[2];
    expect(sessionlessOptions).toEqual(expect.objectContaining({
      permissionMode: 'readonly',
      allowedTools: [],
      onPermissionRequest: expect.any(Function),
    }));

    await requestTeamLeaderPartCompletionCorrection(
      optionsBuilder,
      step,
      part,
      'correct the claim',
      'session-1',
      new AbortController().signal,
      [fileLineIssue],
    );

    const resumedOptions = executeAgentMock.mock.calls[1]?.[2];
    expect(resumedOptions).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      permissionMode: 'readonly',
      allowedTools: [],
    }));
    expect(resumedOptions).not.toHaveProperty('onPermissionRequest');
    expect(buildNewSessionReportOptions).toHaveBeenCalledTimes(1);
    expect(buildResumeOptions).toHaveBeenCalledTimes(1);
  });

  it('keeps a summary correction tool-free for an unsupported sessionless provider', async () => {
    const cwd = createWorkspace();
    executeAgentMock.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'claim',
      timestamp: new Date(),
    });
    const optionsBuilder = {
      buildAgentOptions: vi.fn().mockReturnValue({ cwd, outputSchema: { type: 'object' } }),
      buildNewSessionReportOptions: vi.fn().mockReturnValue({
        cwd,
        resolvedProvider: 'codex',
        permissionMode: 'readonly',
        allowedTools: [],
      }),
    } as unknown as OptionsBuilder;

    await requestTeamLeaderPartCompletionCorrection(
      optionsBuilder,
      step,
      part,
      'correct the summary',
      undefined,
      new AbortController().signal,
      [summaryIssue],
    );

    expect(executeAgentMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'codex',
      permissionMode: 'readonly',
      allowedTools: [],
    }));
    expect(executeAgentMock.mock.calls[0]?.[2]).not.toHaveProperty('onPermissionRequest');
  });

  it('fails before provider execution when file:line inspection is unsupported', async () => {
    const cwd = createWorkspace();
    const optionsBuilder = {
      buildAgentOptions: vi.fn().mockReturnValue({ cwd, outputSchema: { type: 'object' } }),
      buildNewSessionReportOptions: vi.fn().mockReturnValue({
        cwd,
        resolvedProvider: 'codex',
        permissionMode: 'readonly',
        allowedTools: [],
      }),
    } as unknown as OptionsBuilder;

    await expect(requestTeamLeaderPartCompletionCorrection(
      optionsBuilder,
      step,
      part,
      'inspect disputed evidence',
      undefined,
      new AbortController().signal,
      [fileLineIssue],
    )).rejects.toThrow(
      'Provider "codex" does not support path-scoped sessionless part completion inspection',
    );
    expect(executeAgentMock).not.toHaveBeenCalled();
  });

  it('wires summary typed issues to a tool-free Codex recovery attempt', async () => {
    const cwd = createWorkspace();
    executeAgentMock.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'corrected',
      structuredOutput: partCompletionClaim('corrected summary'),
      timestamp: new Date(),
    });
    const deps = createRecoveryDependencies(cwd, 'codex');

    const result = await validateOrRecoverFindingContractPartCompletion(deps, {
      step,
      part,
      response: {
        persona: 'coder',
        status: 'done',
        content: 'invalid summary',
        structuredOutput: partCompletionClaim(''),
        timestamp: new Date(),
      },
      updatePersonaSession: vi.fn(),
    });

    expect(result.claim.summary).toBe('corrected summary');
    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(executeAgentMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'codex',
      permissionMode: 'readonly',
      allowedTools: [],
    }));
    expect(executeAgentMock.mock.calls[0]?.[2]).not.toHaveProperty('onPermissionRequest');
  });

  it('wires disputed file:line issues to capability fail-fast before a Codex attempt', async () => {
    const cwd = createWorkspace();
    const deps = createRecoveryDependencies(cwd, 'codex');

    await expect(validateOrRecoverFindingContractPartCompletion(deps, {
      step,
      part,
      response: {
        persona: 'coder',
        status: 'done',
        content: 'missing file line',
        structuredOutput: partCompletionClaim(
          'disputed',
          'disputed',
          ['inspected the implementation'],
        ),
        timestamp: new Date(),
      },
      updatePersonaSession: vi.fn(),
    })).rejects.toThrow(
      'Provider "codex" does not support path-scoped sessionless part completion inspection',
    );
    expect(executeAgentMock).not.toHaveBeenCalled();
  });
});

describe('Finding Contract part completion recovery', () => {
  const recoveryPart: PartDefinition = {
    id: 'repair',
    title: 'Repair',
    instruction: 'repair',
    findingContract: {
      findingIds: ['F-0001'],
      role: 'repair',
      readPaths: ['src'],
    },
  };

  const recoveryStep: WorkflowStep = {
    name: 'fix',
    persona: 'coder',
    instruction: 'fix',
    teamLeader: {
      mode: 'finding_contract_fix',
      partPersona: 'coder',
    },
  };

  function makeRecoveryResponse(
    structuredOutput: Record<string, unknown>,
    overrides?: Partial<AgentResponse>,
  ): AgentResponse {
    return {
      persona: 'coder',
      status: 'done',
      content: JSON.stringify(structuredOutput),
      timestamp: new Date(),
      structuredOutput,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates only the provider-and-model scoped session after a corrected completion', async () => {
    requestCorrectionMock.mockResolvedValueOnce(makeRecoveryResponse({
      findingOutcomes: [{
        findingId: 'F-0001',
        outcome: 'disputed',
        evidence: ['src/repair.ts:1'],
      }],
      changedPaths: ['src/repair.ts'],
      checks: [],
      summary: 'repaired',
    }, { sessionId: 'session-b' }));
    const updatePersonaSession = vi.fn();
    const normalizeStructuredOutputWithDiagnostics = vi.fn((
      _partStep: WorkflowStep,
      correctionResponse: AgentResponse,
    ) => ({ response: correctionResponse }));

    await validateOrRecoverFindingContractPartCompletion(
      {
        optionsBuilder: {
          resolveStepProviderModel: vi.fn().mockReturnValue({
            provider: 'codex',
            model: 'gpt-5',
          }),
        } as unknown as OptionsBuilder,
        stepExecutor: {
          normalizeStructuredOutputWithDiagnostics,
        } as unknown as StepExecutor,
        language: 'en',
        recordUsage: vi.fn(),
      },
      {
        step: recoveryStep,
        part: recoveryPart,
        response: makeRecoveryResponse({
          findingOutcomes: [{
            findingId: 'F-0001',
            outcome: 'disputed',
            evidence: ['missing location'],
          }],
          changedPaths: ['src/repair.ts'],
          checks: [],
          summary: 'repaired',
        }, { sessionId: 'session-a' }),
        updatePersonaSession,
        abortSignal: new AbortController().signal,
      },
    );

    expect(updatePersonaSession).toHaveBeenCalledWith(
      JSON.stringify(['fix.repair', 'codex', 'gpt-5']),
      'session-b',
    );
    expect(updatePersonaSession).not.toHaveBeenCalledWith(
      JSON.stringify(['fix.repair', 'codex']),
      expect.anything(),
    );
  });

  it('publishes only late usage after the terminal fence closes', async () => {
    const controller = new AbortController();
    let terminalState: TeamLeaderExecutionTerminalState = 'running';
    let resolveCorrection: ((value: AgentResponse) => void) | undefined;
    requestCorrectionMock.mockImplementationOnce(() => new Promise<AgentResponse>((resolve) => {
      resolveCorrection = resolve;
    }));
    const recordUsage = vi.fn();
    const assertRunning = vi.fn((operation: string) => {
      if (terminalState !== 'running') {
        throw new Error(`fenced: ${operation}`);
      }
    });
    const onAttempt = vi.fn();
    const initial = makeRecoveryResponse({
      findingOutcomes: [{
        findingId: 'F-0001',
        outcome: 'disputed',
        evidence: ['missing location'],
      }],
      changedPaths: ['src/repair.ts'],
      checks: [],
      summary: 'repaired',
    }, { sessionId: 'session-a' });
    const normalizeStructuredOutputWithDiagnostics = vi.fn((
      _partStep: WorkflowStep,
      correctionResponse: AgentResponse,
    ) => ({ response: correctionResponse }));
    const recovery = validateOrRecoverFindingContractPartCompletion(
      {
        optionsBuilder: {
          resolveStepProviderModel: vi.fn().mockReturnValue({
            provider: 'mock',
            model: 'mock-model',
          }),
        } as unknown as OptionsBuilder,
        stepExecutor: {
          normalizeStructuredOutputWithDiagnostics,
        } as unknown as StepExecutor,
        language: 'en',
        recordUsage,
      },
      {
        step: recoveryStep,
        part: recoveryPart,
        response: initial,
        updatePersonaSession: vi.fn(),
        onAttempt,
        abortSignal: controller.signal,
        publicationFence: {
          get state() {
            return terminalState;
          },
          assertRunning,
        },
      },
    );

    await vi.waitFor(() => expect(requestCorrectionMock).toHaveBeenCalledTimes(1));
    const callsBeforeTerminal = assertRunning.mock.calls.length;
    terminalState = 'terminated';
    controller.abort(new Error('terminal sibling'));
    await expect(recovery).rejects.toThrow('terminal sibling');

    resolveCorrection?.(makeRecoveryResponse({
      findingOutcomes: [{
        findingId: 'F-0001',
        outcome: 'disputed',
        evidence: ['src/repair.ts:1'],
      }],
      changedPaths: ['src/repair.ts'],
      checks: [],
      summary: 'repaired',
    }, {
      sessionId: 'late-session',
      providerUsage: { usageMissing: false, totalTokens: 17 },
    }));

    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalledTimes(1));
    expect(recordUsage).toHaveBeenCalledWith(
      'fix.repair',
      { provider: 'mock', model: 'mock-model' },
      false,
      { usageMissing: false, totalTokens: 17 },
    );
    expect(assertRunning).toHaveBeenCalledTimes(callsBeforeTerminal);
    expect(onAttempt.mock.calls.flatMap(([event]) => event.type)).not.toContain('late');
  });
});
