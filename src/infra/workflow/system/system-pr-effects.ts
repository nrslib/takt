import type { SystemStepServicesOptions } from '../../../core/workflow/system/system-step-services.js';
import { getGitProvider } from '../../git/index.js';
import { execFileSync } from 'node:child_process';

export function commentPrEffect(
  options: SystemStepServicesOptions,
  payload: { pr: number; body: string; body_format?: 'plain_text' },
): Record<string, unknown> {
  const gitProvider = options.gitProvider ?? getGitProvider();
  let body = payload.body;
  if (payload.body_format === 'plain_text') {
    let fenceLength = 3;
    for (const match of body.matchAll(/`+/gu)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '`'.repeat(fenceLength);
    body = `${fence}text\n${body}\n${fence}`;
  }
  const result = gitProvider.commentOnPr(payload.pr, body, options.projectCwd);
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
