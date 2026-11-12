import type { ConversationDisplayAssignment } from '../manager/conversationPort.js';
import { DaemonEpicFiles } from '../../infra/daemon/epicFiles.js';
import { epicVerificationRecovery } from '../../infra/epics/state.js';
import type { PendingSummary } from '../../infra/conversations/schema.js';
import { GoalStore } from '../../infra/goals/store.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { buildGoalMemory, buildManagerGoalSummary } from '../manager/turnContext.js';
import { getErrorMessage } from '../../shared/utils/error.js';

export async function buildTurnBusinessContext(assignment: ConversationDisplayAssignment, pending: PendingSummary | null, configDirectory: string): Promise<string> {
  const memories = [];
  let remainingBytes = 64 * 1024;
  for (const repositoryDirectory of assignment.repositoryDirectories) {
    try {
      const tasks = new TaskRunner(repositoryDirectory).listTaskStateItems();
      const goals = [];
      let goalCount = 0;
      for await (const goal of new GoalStore(repositoryDirectory).iterate()) {
        goalCount++;
        const summary = buildManagerGoalSummary(repositoryDirectory, goal, tasks);
        const bytes = Buffer.byteLength(JSON.stringify(summary));
        if (bytes <= remainingBytes) { goals.push(summary); remainingBytes -= bytes; }
      }
      memories.push({ repositoryDirectory, goals, goalCount, diagnostics: [] });
    } catch (error) { memories.push({ repositoryDirectory, goals: undefined, diagnostics: [{ message: getErrorMessage(error) }] }); }
  }
  let epics = '';
  if (assignment.kind === 'workspace') {
    for await (const epic of new DaemonEpicFiles(configDirectory).list(assignment.workspaceId)) {
      if (epics.length > 0) epics += ',';
      epics += JSON.stringify({ epic, recovery: epicVerificationRecovery(epic) });
    }
  }
  return `{"assignment":${JSON.stringify(assignment)},"pending":${JSON.stringify(pending)},"epics":[${epics}],"goals":${buildGoalMemory(memories)}}`;
}
