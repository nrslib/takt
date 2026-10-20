import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import type { LiveInterventionDeliveryPersistence } from '../../../infra/workflow/live-intervention-store.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import {
  resolveTaskSpecForExecution,
  restageTaskSpecForExecution,
  type ResolvedTaskSpec,
} from './taskSpecContext.js';

export function persistDeliveredLiveInstructions(
  projectCwd: string,
  execCwd: string,
  taskSpec: ResolvedTaskSpec | undefined,
  runPaths: RunPaths,
  instructions: Parameters<LiveInterventionDeliveryPersistence>[0],
): void {
  for (const { instructionId, issuedAt, content } of instructions) {
    try {
      if (taskSpec === undefined) {
        throw new Error('Tell target task is missing taskDir');
      }
      const orderPath = path.join(taskSpec.sourceTaskDir, 'order.md');
      if (!fs.lstatSync(orderPath).isFile()) {
        throw new Error(`Task spec file must be a regular file: ${orderPath}`);
      }
      const descriptor = fs.openSync(
        orderPath,
        fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
      );
      try {
        if (!fs.fstatSync(descriptor).isFile()) {
          throw new Error(`Task spec file must be a regular file: ${orderPath}`);
        }
        fs.appendFileSync(
          descriptor,
          `\n\n## 追加の指示\n\ninstructionId: ${instructionId}\n受信時刻: ${issuedAt}\n\n${content}\n`,
          'utf-8',
        );
      } finally {
        fs.closeSync(descriptor);
      }
      const refreshedSpec = resolveTaskSpecForExecution(
        projectCwd, execCwd, path.relative(projectCwd, taskSpec.sourceTaskDir), runPaths.slug, runPaths,
      );
      restageTaskSpecForExecution(refreshedSpec, runPaths);
    } catch (error) {
      // A persistence failure must not undo an instruction already delivered.
      process.stderr.write(
        `Warning: Could not persist tell instruction for run ${runPaths.slug}, instructionId ${instructionId}: ${getErrorMessage(error)}\n`,
      );
    }
  }
}
