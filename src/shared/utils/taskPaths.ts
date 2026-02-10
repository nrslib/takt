const TASK_SLUG_PATTERN =
  '[a-z0-9\\u3040-\\u309f\\u30a0-\\u30ff\\u4e00-\\u9faf](?:[a-z0-9\\u3040-\\u309f\\u30a0-\\u30ff\\u4e00-\\u9faf-]*[a-z0-9\\u3040-\\u309f\\u30a0-\\u30ff\\u4e00-\\u9faf])?';
const TASK_DIR_PREFIX = '.takt/tasks/';
const TASK_DIR_PATTERN = new RegExp(`^\\.takt/tasks/${TASK_SLUG_PATTERN}$`);
const REPORT_DIR_NAME_PATTERN = new RegExp(`^${TASK_SLUG_PATTERN}$`);

export function isValidTaskDir(taskDir: string): boolean {
  return TASK_DIR_PATTERN.test(taskDir);
}

export function getTaskSlugFromTaskDir(taskDir: string): string | undefined {
  if (!isValidTaskDir(taskDir)) {
    return undefined;
  }
  return taskDir.slice(TASK_DIR_PREFIX.length);
}

export function isValidReportDirName(reportDirName: string): boolean {
  return REPORT_DIR_NAME_PATTERN.test(reportDirName);
}
