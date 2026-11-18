import type { ConversationDisplayAssignment } from '../manager/conversationPort.js';
import { DaemonEpicFiles } from '../../infra/daemon/epicFiles.js';
import { epicVerificationRecovery } from '../../infra/epics/state.js';
import type { PendingSummary } from '../../infra/conversations/schema.js';
import { GoalStore } from '../../infra/goals/store.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { buildGoalMemory, buildManagerGoalSummary } from '../manager/turnContext.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';

const EPIC_CONTEXT_MAX_BYTES = 16 * 1024;
const epicRetrieval = 'Use takt_get_epic with epicId and path/textOffset/maxBytes for full details; use takt_list_epics with offset/limit for other Epics.';

function summarizeEpic(epic: Awaited<ReturnType<DaemonEpicFiles['get']>>) {
  const briefRun = (run: typeof epic.verificationRuns[number]) => ({ id: run.id, revision: run.revision,
    status: run.status, startedAt: run.startedAt,
    ...(run.invalidationReason === undefined ? {} : { invalidationReason: truncateUtf8(run.invalidationReason, 128).value }),
  });
  return {
    id: epic.id,
    workspaceId: epic.workspaceId,
    revision: epic.revision,
    status: epic.status,
    objective: truncateUtf8(epic.objective, 512).value,
    acceptanceCriteria: epic.acceptanceCriteria.slice(0, 5).map(({ id, description }) => ({
      id: truncateUtf8(id, 128).value, description: truncateUtf8(description, 128).value,
    })),
    acceptanceCriterionCount: epic.acceptanceCriteria.length,
    verificationProcedure: { version: epic.verificationProcedure.version,
      steps: epic.verificationProcedure.steps.slice(0, 5).map((step) => truncateUtf8(step, 128).value),
      stepCount: epic.verificationProcedure.steps.length, terraform: epic.verificationProcedure.terraform },
    members: epic.members.slice(0, 6).map((member) => ({ ...member,
      repositoryDirectory: truncateUtf8(member.repositoryDirectory, 128).value })),
    memberCount: epic.members.length,
    targets: epic.targets.slice(0, 6).map((target) => ({ ...target,
      repositoryDirectory: truncateUtf8(target.repositoryDirectory, 128).value })),
    targetCount: epic.targets.length,
    verificationRuns: epic.verificationRuns.slice(-4).map(briefRun),
    verificationRunCount: epic.verificationRuns.length,
    changes: epic.changes.slice(-4).map((change) => ({ kind: change.kind,
      reason: truncateUtf8(change.reason, 128).value, recordedAt: change.recordedAt })),
    changeCount: epic.changes.length,
    ...(epic.currentEvidence === undefined ? {} : { currentEvidence: briefRun(epic.currentEvidence) }),
    ...(epic.runningVerification === undefined ? {} : { runningVerification: briefRun(epic.runningVerification) }),
    detailsTruncated: true,
    retrieval: epicRetrieval,
  };
}

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
  const epics: { epic: unknown; recovery: unknown[] }[] = [];
  let epicsTruncated = false;
  if (assignment.kind === 'workspace') {
    for await (const epic of new DaemonEpicFiles(configDirectory).list(assignment.workspaceId)) {
      const recovery = epicVerificationRecovery(epic);
      const full = { epic, recovery };
      if (Buffer.byteLength(JSON.stringify([...epics, full])) <= EPIC_CONTEXT_MAX_BYTES) {
        epics.push(full);
        continue;
      }
      epicsTruncated = true;
      const brief = { epic: summarizeEpic(epic), recovery: recovery.map(({ id, revision, status, startedAt }) => ({ id, revision, status, startedAt })) };
      if (Buffer.byteLength(JSON.stringify([...epics, brief])) > EPIC_CONTEXT_MAX_BYTES) break;
      epics.push(brief);
    }
  }
  return `{"assignment":${JSON.stringify(assignment)},"pending":${JSON.stringify(pending)},"epics":${JSON.stringify(epics)},"epicsTruncated":${epicsTruncated},"epicRetrieval":${JSON.stringify(epicRetrieval)},"goals":${buildGoalMemory(memories)}}`;
}
