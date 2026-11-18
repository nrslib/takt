import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import { GoalStore } from '../../../infra/goals/store.js';

const specificationFiles = {
  gherkin: 'gherkin.feature',
  quint: 'quint.qnt',
  alloy: 'alloy.als',
} as const;

export function stageGoalSpecificationsForExecution(
  projectCwd: string,
  goalId: string | undefined,
  runPaths: RunPaths,
): string[] {
  if (goalId === undefined) return [];
  const { specifications } = new GoalStore(projectCwd).getSync(goalId);
  if (specifications === undefined) return [];
  const directory = join(runPaths.contextTaskAbs, 'specifications');
  const files = (Object.keys(specificationFiles) as (keyof typeof specificationFiles)[])
    .flatMap((notation) => {
      const content = specifications[notation];
      return content === undefined ? [] : [{ path: join(directory, specificationFiles[notation]), content }];
    });
  if (files.length === 0) return [];
  try {
    mkdirSync(directory, { recursive: true });
    for (const file of files) writeFileSync(file.path, file.content, 'utf8');
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return files.map((file) => file.path);
}
