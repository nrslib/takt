import { execFileSync } from 'node:child_process';
import { success, error as logError, StreamDisplay } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { getProvider, type ProviderType } from '../../../infra/providers/index.js';
import { resolveConfigValues } from '../../../infra/config/index.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import { getLanguage } from '../../../infra/config/index.js';
import {
  type BranchActionTarget,
  resolveTargetBranch,
  resolveTargetInstruction,
  validateWorktreeTarget,
  pushWorktreeToOrigin,
} from './taskActionTarget.js';

const log = createLogger('list-tasks');

const SYNC_REF = 'refs/remotes/root/sync-target';

export async function syncBranchWithRoot(
  projectDir: string,
  target: BranchActionTarget,
): Promise<boolean> {
  if (!validateWorktreeTarget(target, 'Sync')) {
    return false;
  }
  const worktreePath = target.worktreePath;

  // origin is removed in worktrees; pass the project path directly as the remote
  try {
    execFileSync('git', ['fetch', projectDir, `HEAD:${SYNC_REF}`], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    log.info('Fetched root HEAD into sync-target ref', { worktreePath, projectDir });
  } catch (err) {
    const msg = getErrorMessage(err);
    logError(`Failed to fetch from root: ${msg}`);
    log.error('git fetch failed', { worktreePath, projectDir, error: msg });
    return false;
  }

  let mergeConflict = false;
  try {
    execFileSync('git', ['merge', SYNC_REF], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    mergeConflict = true;
    log.info('Merge conflict detected, attempting AI resolution', {
      worktreePath,
      error: getErrorMessage(err),
    });
  }

  if (!mergeConflict) {
    if (!pushSynced(worktreePath, projectDir, target)) {
      return false;
    }
    success('Synced & pushed.');
    log.info('Merge succeeded without conflicts', { worktreePath });
    return true;
  }

  const lang = getLanguage();
  const originalInstruction = resolveTargetInstruction(target);
  const systemPrompt = loadTemplate('sync_conflict_resolver_system_prompt', lang);
  const prompt = loadTemplate('sync_conflict_resolver_message', lang, { originalInstruction });

  const config = resolveConfigValues(projectDir, ['provider', 'model']);
  if (!config.provider) {
    throw new Error('No provider configured. Set "provider" in ~/.takt/config.yaml');
  }
  const providerType = config.provider as ProviderType;
  const provider = getProvider(providerType);
  const agent = provider.setup({ name: 'conflict-resolver', systemPrompt });

  const response = await agent.call(prompt, {
    cwd: worktreePath,
    model: config.model,
    permissionMode: 'edit',
    onPermissionRequest: autoApproveBash,
    onStream: new StreamDisplay('conflict-resolver', false).createHandler(),
  });

  if (response.status === 'done') {
    if (!pushSynced(worktreePath, projectDir, target)) {
      return false;
    }
    success('Conflicts resolved & pushed.');
    log.info('AI conflict resolution succeeded', { worktreePath });
    return true;
  }

  abortMerge(worktreePath);
  logError('Failed to resolve conflicts. Merge aborted.');
  return false;
}

/** Auto-approve all tool invocations (agent runs in isolated worktree) */
async function autoApproveBash(request: { toolName: string; input: Record<string, unknown> }) {
  return { behavior: 'allow' as const, updatedInput: request.input };
}

function pushSynced(worktreePath: string, projectDir: string, target: BranchActionTarget): boolean {
  const branch = resolveTargetBranch(target);
  try {
    pushWorktreeToOrigin(worktreePath, projectDir, branch);
  } catch (err) {
    logError(`Push failed after sync: ${getErrorMessage(err)}`);
    log.error('pushWorktreeToOrigin failed', { worktreePath, projectDir, branch, error: getErrorMessage(err) });
    return false;
  }
  return true;
}

function abortMerge(worktreePath: string): void {
  try {
    execFileSync('git', ['merge', '--abort'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    log.info('git merge --abort completed', { worktreePath });
  } catch (err) {
    logError(`Failed to abort merge: ${getErrorMessage(err)}`);
    log.error('git merge --abort failed', { worktreePath, error: getErrorMessage(err) });
  }
}
