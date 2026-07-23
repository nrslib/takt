import { resolve } from 'node:path';
import type { RunAgentOptions } from '../../../agents/types.js';
import type { PartDefinition } from '../../models/types.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import { isRealPathInside } from '../../../shared/utils/index.js';
import {
  normalizeFindingContractPath,
  requireNonEmptyString,
} from '../team-leader-finding-contract-validation.js';
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

function collectInspectionPaths(part: PartDefinition): string[] {
  if (part.findingContract === undefined) {
    throw new Error(`Part "${part.id}" is missing findingContract assignment`);
  }
  return Array.from(new Set([
    ...part.findingContract.readPaths,
    ...part.findingContract.writePaths,
  ].map((path, index) => {
    const label = `Part "${part.id}" inspectionPaths[${index}]`;
    return normalizeFindingContractPath(requireNonEmptyString(path, label), label);
  })));
}

function buildClaudeReadRules(paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    if (path === '.') {
      return ['Read(**)'];
    }
    return [`Read(${path})`, `Read(${path}/**)`];
  });
}

function isAllowedReadPath(
  cwd: string,
  allowedRoots: readonly string[],
  candidatePath: unknown,
): candidatePath is string {
  if (typeof candidatePath !== 'string' || candidatePath.trim().length === 0) {
    return false;
  }
  const candidate = resolve(cwd, candidatePath);
  return isRealPathInside(cwd, candidate)
    && allowedRoots.some((root) => isRealPathInside(root, candidate));
}

function buildClaudeInspectionOptions(
  cwd: string,
  paths: readonly string[],
): SessionlessInspectionOptions {
  const allowedRoots = paths.map((path) => resolve(cwd, path));
  return {
    allowedTools: buildClaudeReadRules(paths),
    onPermissionRequest: async (request) => {
      if (
        request.toolName === 'Read'
        && isAllowedReadPath(cwd, allowedRoots, request.input.file_path)
      ) {
        return { behavior: 'allow', updatedInput: request.input };
      }
      return {
        behavior: 'deny',
        message: 'Part completion inspection only permits file reads within findingContract readPaths and writePaths.',
      };
    },
  };
}

export function buildSessionlessPartCompletionInspectionOptions(
  part: PartDefinition,
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
  const paths = collectInspectionPaths(part);
  if (paths.length === 0) {
    return { allowedTools: [] };
  }
  if (provider === undefined) {
    throw new Error('Sessionless part completion inspection requires a resolved provider');
  }
  if (SESSIONLESS_INSPECTION_CAPABILITY[provider] === 'claude') {
    return buildClaudeInspectionOptions(cwd, paths);
  }
  throw new Error(
    `Provider "${provider}" does not support path-scoped sessionless part completion inspection`,
  );
}
