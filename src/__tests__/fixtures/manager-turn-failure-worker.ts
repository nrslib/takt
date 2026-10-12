import { existsSync, writeFileSync } from 'node:fs';
import { processGoalCompletions } from '../../features/manager/completionTurn.js';
import { getScenarioQueue, setMockScenario } from '../../infra/mock/scenario.js';

const [cwd, goalId, readyFile, releaseFile] = process.argv.slice(2);
if (cwd === undefined || goalId === undefined || readyFile === undefined || releaseFile === undefined) {
  throw new Error('Expected cwd, goal ID, readiness file and release file');
}
setMockScenario([{ persona: 'manager', status: 'error', content: '', error: 'capacity exhausted', mcpToolCalls: [] }]);
writeFileSync(readyFile, 'ready');
const deadline = Date.now() + 15_000;
while (!existsSync(releaseFile)) {
  if (Date.now() >= deadline) throw new Error('Release file was not published');
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}
await processGoalCompletions(cwd, goalId);
const queue = getScenarioQueue();
if (queue === null) throw new Error('Mock scenario queue is not installed');
if (queue.remaining !== 0) throw new Error('Mock manager failure was not consumed');
