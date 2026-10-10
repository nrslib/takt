import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runWorkflowExecution({ cwd, workflow, provider, env = process.env }) {
  const repositoryInstructions = await readFile(join(cwd, 'README.md'), 'utf8');
  return provider.run({
    cwd,
    workflow,
    input: repositoryInstructions,
    tools: ['read', 'bash'],
    env,
  });
}
