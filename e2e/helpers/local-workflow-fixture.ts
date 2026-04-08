import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

function copyDirRecursive(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);
    const stat = statSync(sourcePath);
    if (stat.isDirectory()) {
      copyDirRecursive(sourcePath, targetPath);
      continue;
    }
    writeFileSync(targetPath, readFileSync(sourcePath));
  }
}

export function copyWorkflowFixtureToRepo(repoPath: string, fixturePath: string): string {
  const sourceDir = dirname(fixturePath);
  const targetDir = join(repoPath, '.takt', 'workflows', 'e2e-fixtures', basename(sourceDir));
  mkdirSync(targetDir, { recursive: true });

  const targetWorkflowPath = join(targetDir, basename(fixturePath));
  writeFileSync(targetWorkflowPath, readFileSync(fixturePath));

  const sourceAgentsDir = join(sourceDir, 'agents');
  if (existsSync(sourceAgentsDir)) {
    copyDirRecursive(sourceAgentsDir, join(targetDir, 'agents'));
  }

  return targetWorkflowPath;
}
