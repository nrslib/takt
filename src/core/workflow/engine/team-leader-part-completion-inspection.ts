import { resolve } from 'node:path';
import type { RunAgentOptions } from '../../../agents/types.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import { isRealPathInside } from '../../../shared/utils/index.js';
import type {
  FindingContractControlValidationIssue,
} from '../team-leader-finding-contract-control-validation.js';

type SessionlessInspectionOptions = Pick<RunAgentOptions, 'allowedTools' | 'onPermissionRequest'>;

const FILE_LINE_INSPECTION_ISSUE_CODE = 'evidence.disputed_file_line';

const SESSIONLESS_INSPECTION_CAPABILITY: Record<ProviderType, 'claude' | 'unsupported'> = {
  'claude-sdk': 'claude',
  mock: 'claude',
  claude: 'unsupported',
  'claude-terminal': 'unsupported',
  codex: 'unsupported',
  opencode: 'unsupported',
  cursor: 'unsupported',
  copilot: 'unsupported',
  kiro: 'unsupported',
};

function isAllowedReadPath(
  cwd: string,
  candidatePath: unknown,
): candidatePath is string {
  if (typeof candidatePath !== 'string' || candidatePath.trim().length === 0) {
    return false;
  }
  const candidate = resolve(cwd, candidatePath);
  return isRealPathInside(cwd, candidate);
}

function buildClaudeInspectionOptions(
  cwd: string,
): SessionlessInspectionOptions {
  return {
    allowedTools: [],
    onPermissionRequest: async (request) => {
      if (
        request.toolName === 'Read'
        && isAllowedReadPath(cwd, request.input.file_path)
      ) {
        return { behavior: 'allow', updatedInput: request.input };
      }
      return {
        behavior: 'deny',
        message: 'Part completion inspection only permits file reads within the working directory.',
      };
    },
  };
}

export function buildSessionlessPartCompletionInspectionOptions(
  cwd: string,
  provider: ProviderType | undefined,
  issues: readonly FindingContractControlValidationIssue[],
): SessionlessInspectionOptions {
  const requiresInspection = issues.some(
    (issue) => issue.code === FILE_LINE_INSPECTION_ISSUE_CODE,
  );
  if (!requiresInspection) {
    return { allowedTools: [] };
  }
  if (provider === undefined) {
    throw new Error('Sessionless part completion inspection requires a resolved provider');
  }
  if (SESSIONLESS_INSPECTION_CAPABILITY[provider] === 'claude') {
    return buildClaudeInspectionOptions(cwd);
  }
  throw new Error(
    `Provider "${provider}" does not support path-scoped sessionless part completion inspection`,
  );
}
