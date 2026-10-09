import type { SystemStepServicesOptions } from '../../../core/workflow/system/system-step-services.js';
import { getGitProvider } from '../../git/index.js';
import { execFileSync } from 'node:child_process';

export function commentPrEffect(
  options: SystemStepServicesOptions,
  payload: { pr: number; body: string },
): Record<string, unknown> {
  const gitProvider = options.gitProvider ?? getGitProvider();
  const result = gitProvider.commentOnPr(payload.pr, payload.body, options.projectCwd);
  return {
    success: result.success,
    failed: result.success !== true,
    ...(result.error ? { error: result.error } : {}),
  };
}

export function mergePrEffect(
  options: SystemStepServicesOptions,
  payload: { pr: number },
): Record<string, unknown> {
  const gitProvider = options.gitProvider ?? getGitProvider();
  let result;
  if (options.prExecutionContext) {
    if (options.prExecutionContext.prNumber !== payload.pr || options.cwd === options.projectCwd) {
      return { success: false, failed: true, error: 'A matching PR clone is required for merge' };
    }
    try {
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: options.cwd, encoding: 'utf8', stdio: 'pipe',
      }).trim();
      result = gitProvider.mergePr(payload.pr, options.projectCwd, options.mergeMethod, headSha);
    } catch (error) {
      return { success: false, failed: true, error: String(error) };
    }
  } else {
    result = gitProvider.mergePr(payload.pr, options.projectCwd, options.mergeMethod);
  }
  return {
    success: result.success,
    failed: result.success !== true,
    ...(result.error ? { error: result.error } : {}),
  };
}

export function closePrEffect(
  options: SystemStepServicesOptions,
  payload: { pr: number },
): Record<string, unknown> {
  const gitProvider = options.gitProvider ?? getGitProvider();
  const result = gitProvider.closePr(payload.pr, options.projectCwd);
  return {
    success: result.success,
    failed: result.success !== true,
    ...(result.error ? { error: result.error } : {}),
  };
}
