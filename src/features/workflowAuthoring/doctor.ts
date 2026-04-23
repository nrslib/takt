import { error, success, warn } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { inspectWorkflowFile, resolveWorkflowDoctorTargets } from '../../infra/config/loaders/workflowDoctor.js';

export async function doctorWorkflowCommand(
  targets: string[],
  projectDir: string,
): Promise<void> {
  const resolvedTargets = resolveWorkflowDoctorTargets(targets, projectDir);
  if (resolvedTargets.length === 0) {
    throw new Error('No workflow files found to validate');
  }

  let hasErrors = false;
  for (const { filePath, lookupCwd, source } of resolvedTargets) {
    const report = inspectWorkflowFile(filePath, projectDir, { lookupCwd, source });
    if (report.diagnostics.length === 0) {
      success(`Workflow OK: ${sanitizeTerminalText(filePath)}`);
      continue;
    }

    for (const diagnostic of report.diagnostics) {
      const message = sanitizeTerminalText(diagnostic.message);
      if (diagnostic.level === 'error') {
        hasErrors = true;
        error(`${sanitizeTerminalText(filePath)}: ${message}`);
      } else {
        warn(`${sanitizeTerminalText(filePath)}: ${message}`);
      }
    }
  }

  if (hasErrors) {
    throw new Error('Workflow validation failed');
  }
}
