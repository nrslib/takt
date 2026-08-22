import type { SystemStepServicesOptions } from '../../../core/workflow/system/system-step-services.js';
import { getGitProvider } from '../../git/index.js';

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
  const result = gitProvider.mergePr(payload.pr, options.projectCwd);
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
