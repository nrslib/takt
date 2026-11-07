import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { conversationId } from '../../infra/conversations/identity.js';
import type { InquiryNotice } from '../../core/daemon/messages.js';
import { readPrivateFile } from '../../infra/daemon/privateFile.js';
import { AsyncProcess } from '../../infra/daemon/process.js';
import type { DaemonWatchSource } from './watchers/index.js';
import type { RunWatchTarget, LaunchWatchTarget } from './watchers/checks.js';
import type { PullRequestWatchTarget } from './watchers/pullRequests.js';
import type { DirectoryWatchTarget } from './watchers/directories.js';
import type { WatchObservations } from './watchers/observations.js';
import { listWatchEntries } from './watchers/files.js';
import { readWatchGoal, readWatchGoals, readWatchInquiries, readWatchTasks } from './watchers/state.js';
import { DaemonConversations } from './conversationState.js';
import { projectKey, routeAssignment } from './routing.js';
import { globalDaemonConfiguration, readDaemonConfiguration } from './configuration.js';
import { DaemonPersistedFiles, type DaemonInquiryOwner } from '../../infra/daemon/persistedFiles.js';
import type { ManagerPatrolTarget } from './patrols.js';
import { WatchGoalReader } from './watchers/goalReader.js';
import type { GoalQuestion } from '../../infra/goals/schema.js';
import { publishPendingInquiryAnswers } from './pendingInquiryAnswers.js';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 保存ファイルから観測対象を組み立てる。 */
export class FileDaemonWatchSource implements DaemonWatchSource {
  private readonly goalReader = new WatchGoalReader();

  async close(): Promise<void> { await this.goalReader.close(); }
  private readonly inquiriesSeen = new Map<string, string>();
  private inquiriesInitialized = false;
  constructor(private readonly conversations: DaemonConversations,
    private readonly publish: (notice: InquiryNotice) => Promise<void>, private readonly onError: (error: unknown) => void,
    private readonly stateChanges?: WatchObservations,
    private readonly publishAnswer?: (owner: DaemonInquiryOwner, question: GoalQuestion) => Promise<void>) {}

  private async *projects() {
    for (const route of await this.conversations.routing.routes()) {
      const assignment = routeAssignment(route);
      await this.conversations.ensure(assignment);
      yield { ...route, assignment, conversationId: conversationId(assignment) };
    }
  }

  async hasWork(files: DaemonPersistedFiles): Promise<boolean> {
    for await (const project of this.projects()) {
      let goalReadFailed = false;
      for await (const goal of readWatchGoals(project.repositoryDirectory, (error) => {
        goalReadFailed = true;
        this.onError(error);
      }, this.goalReader)) {
        if (goal.status !== 'completed' && goal.executionStatus !== 'aborted') return true;
      }
      // 読取失敗ではゴールの終了を確認できないため、daemon を維持する。
      if (goalReadFailed) return true;
      if ((await listWatchEntries(await files.inboxDirectory(project.repositoryDirectory))).some((entry) => entry.isFile() && entry.name.endsWith('.json'))) return true;
      try {
        if ((await readWatchTasks(project.repositoryDirectory)).some((task) => task.status === 'pending' || task.status === 'running')) return true;
      } catch (error) { this.onError(error); }
    }
    for (const assignment of await this.conversations.routing.assignments()) {
      if (assignment.kind === 'daemon') continue;
      const owner: DaemonInquiryOwner = assignment.kind === 'workspace'
        ? { kind: 'workspace', workspaceId: assignment.workspaceId }
        : { kind: 'repository', repositoryDirectory: assignment.repositoryDirectory };
      if ((await files.listPendingInquiryAnswerPublications(owner)).length > 0) return true;
    }
    return false;
  }

  async runs(): Promise<readonly RunWatchTarget[]> {
    const targets: RunWatchTarget[] = [];
    for await (const project of this.projects()) {
      try {
        for (const task of await readWatchTasks(project.repositoryDirectory)) {
          if (task.status !== 'running' || task.goal_id === undefined) continue;
          targets.push({ targetId: digest([project.repositoryDirectory, task.name]),
            generation: digest([task.run_slug, task.execution_id, task.owner_pid, task.owner_start_time]), conversationId: project.conversationId,
            task: { repositoryDirectory: project.repositoryDirectory, goalId: task.goal_id, taskName: task.name,
              ...(task.run_slug === undefined ? {} : { runSlug: task.run_slug }),
              ...(task.execution_id === undefined ? {} : { executionId: task.execution_id }) },
            owner: task.owner_pid == null ? null : { pid: task.owner_pid, startTime: task.owner_start_time ?? null },
            running: true });
        }
      } catch (error) { this.onError(error); }
    }
    return targets;
  }

  async run(targetId: string): Promise<RunWatchTarget | undefined> { return (await this.runs()).find((target) => target.targetId === targetId); }

  async patrols(): Promise<readonly ManagerPatrolTarget[]> {
    const global = await globalDaemonConfiguration(this.conversations.routing.directory);
    const targets: ManagerPatrolTarget[] = [];
    for await (const project of this.projects()) {
      try {
        const config = await readDaemonConfiguration(join(project.repositoryDirectory, '.takt', 'config.yaml'));
        targets.push({ conversationId: project.conversationId, repositoryDirectory: project.repositoryDirectory,
          intervalSeconds: config.manager?.patrol_interval ?? global.manager?.patrol_interval ?? 1800 });
      } catch (error) { this.onError(error); }
    }
    return targets;
  }

  async patrolGoalIds(repositoryDirectory: string): Promise<readonly string[]> {
    const ids: string[] = [];
    for await (const goal of readWatchGoals(repositoryDirectory, this.onError, this.goalReader)) {
      if (goal.executionStatus === 'active' && goal.status !== 'completed' && goal.status !== 'awaiting_merge') ids.push(goal.id);
    }
    return ids;
  }

  async pullRequests(): Promise<readonly PullRequestWatchTarget[]> {
    const targets: PullRequestWatchTarget[] = [];
    for await (const project of this.projects()) {
      try {
        for await (const goal of readWatchGoals(project.repositoryDirectory, this.onError, this.goalReader)) {
          if (goal.pullRequest === undefined || goal.status !== 'awaiting_merge' || goal.executionStatus !== 'active') continue;
          targets.push({ targetId: digest([project.repositoryDirectory, goal.id]), generation: digest(goal.pullRequest), conversationId: project.conversationId,
            repositoryDirectory: project.repositoryDirectory, goalId: goal.id, awaitingMerge: true,
            ...goal.pullRequest, headBranch: goal.branch, baseBranch: goal.integrationBranch });
        }
      } catch (error) { this.onError(error); }
    }
    return targets;
  }

  async inquiries(): Promise<void> {
    const present = new Set<string>();
    for await (const notice of this.inquiryNotices()) {
      const key = JSON.stringify([notice.conversationId, notice.target, notice.question.id]);
      present.add(key);
      const version = digest(notice.question);
      if (this.inquiriesSeen.get(key) !== version) {
        if (this.inquiriesInitialized) await this.publish(notice);
        this.inquiriesSeen.set(key, version);
      }
    }
    this.inquiriesInitialized = true;
    for (const key of this.inquiriesSeen.keys()) if (!present.has(key)) this.inquiriesSeen.delete(key);
    await this.publishPendingAnswers();
  }

  private async publishPendingAnswers(): Promise<void> {
    if (this.publishAnswer === undefined) return;
    const owners = (await this.conversations.routing.assignments()).flatMap((assignment): DaemonInquiryOwner[] => assignment.kind === 'daemon'
      ? [] : [assignment.kind === 'workspace' ? { kind: 'workspace', workspaceId: assignment.workspaceId }
        : { kind: 'repository', repositoryDirectory: assignment.repositoryDirectory }]);
    await publishPendingInquiryAnswers(this.conversations.routing.directory, owners, this.publishAnswer, this.onError);
  }

  private async *inquiryNotices(): AsyncGenerator<InquiryNotice> {
    const assignments = new Map<string, { assignment: Exclude<import('../../infra/conversations/schema.js').ConversationAssignment, { kind: 'daemon' }>; directory: string }>();
    for await (const project of this.projects()) {
      const { assignment } = project;
      if (assignment.kind === 'daemon') throw new Error('Manager assignment required');
      assignments.set(project.conversationId, { assignment, directory: assignment.kind === 'workspace'
        ? join(this.conversations.routing.directory, 'workspaces', assignment.workspaceId, 'inquiries')
        : join(this.conversations.routing.directory, 'projects', projectKey(project.repositoryDirectory), 'inquiries') });
      try {
        for await (const goal of readWatchGoals(project.repositoryDirectory, this.onError, this.goalReader)) {
          await this.directorChanged(project.conversationId, project.repositoryDirectory, goal.id, { status: goal.status, executionStatus: goal.executionStatus,
            blockedNotifications: goal.blockedNotifications,
            pendingInquiries: (goal.questions ?? []).filter((question) => question.status === 'pending' && question.recipient === 'human').map((question) => question.id).sort() },
          goal.status === 'completed' || goal.executionStatus === 'aborted');
          for (const question of goal.questions ?? []) {
            yield { conversationId: project.conversationId, target: { goalId: goal.id, repositoryDirectory: project.repositoryDirectory }, question };
          }
        }
      } catch (error) { this.onError(error); }
    }
    for (const [id, { assignment, directory }] of assignments) {
      const pendingInquiries: string[] = [];
      try {
        for await (const question of readWatchInquiries(directory)) {
          if (question.status === 'pending' && question.recipient === 'human') pendingInquiries.push(question.id);
          yield { conversationId: id, target: { goalId: null, owner: assignment }, question };
        }
      } catch (error) { this.onError(error); }
      const repositories = await this.conversations.routing.display(assignment);
      const repository = repositories.repositoryDirectories[0];
      if (repository !== undefined && pendingInquiries.length > 0) await this.directorChanged(id, repository, null, { pendingInquiries: pendingInquiries.sort() });
    }
  }

  private async directorChanged(managerConversationId: string, repositoryDirectory: string, goalId: string | null, state: unknown, settled = false): Promise<void> {
    if (this.stateChanges === undefined) return;
    const target = { conversationId: conversationId({ kind: 'daemon' }), targetId: digest([managerConversationId, repositoryDirectory, goalId]), generation: digest(state) };
    await this.stateChanges.changed(target, { ...this.stateChanges.evidence(target), kind: 'director_state_changed',
      managerConversationId, repositoryDirectory, goalId, state: JSON.stringify(state) }, settled);
  }

  async launches(): Promise<readonly LaunchWatchTarget[]> {
    const targets: LaunchWatchTarget[] = [];
    const global = await globalDaemonConfiguration(this.conversations.routing.directory);
    for await (const project of this.projects()) {
      try {
        const tasks = await readWatchTasks(project.repositoryDirectory);
        const pending = [];
        for (const task of tasks) {
          if (task.status !== 'pending' || task.goal_id === undefined) continue;
          try {
            const goal = await readWatchGoal(project.repositoryDirectory, task.goal_id, this.goalReader);
            if ((goal.status === 'created' || task.merge_task === true && goal.status === 'awaiting_merge') && goal.executionStatus === 'active') pending.push(task);
          } catch (error) { this.onError(error); }
        }
        if (pending.length === 0) continue;
        const projectConfig = await readDaemonConfiguration(join(project.repositoryDirectory, '.takt', 'config.yaml'));
        const owners = (await listWatchEntries(join(project.repositoryDirectory, '.takt', 'execution.lock'))).filter((entry) => entry.name.startsWith('owner-') && entry.name.endsWith('.json'));
        let owner: LaunchWatchTarget['owner'] = 'absent';
        let launching: boolean | null = false;
        for (const entry of owners) {
          const bytes = await readPrivateFile(join(project.repositoryDirectory, '.takt', 'execution.lock', entry.name), 16 * 1024);
          if (bytes === undefined) { owner = 'unknown'; launching = null; continue; }
          const saved = z.object({ pid: z.number().int().positive(), processIdentity: z.object({ startTime: z.string().min(1) }), state: z.enum(['starting', 'running', 'stopping']) }).parse(JSON.parse(bytes.toString('utf8')) as unknown);
          const observed = await new AsyncProcess().inspect({ pid: saved.pid, startTime: saved.processIdentity.startTime }, { signal: new AbortController().signal, timeoutMs: 5000 });
          owner = observed.kind === 'alive' ? 'present' : observed.kind === 'dead' ? owner : 'unknown';
          launching = observed.kind === 'unknown' ? null : observed.kind === 'alive' && saved.state === 'starting';
        }
        targets.push({ targetId: projectKey(project.repositoryDirectory), generation: digest(pending.map((task) => [task.name, task.created_at])),
          conversationId: project.conversationId, repositoryDirectory: project.repositoryDirectory,
          autoRun: projectConfig.manager?.auto_run ?? global.manager?.auto_run ?? true, runnablePending: true, owner, launching,
          pendingSince: pending.map((task) => task.created_at).sort()[0]! });
      } catch (error) { this.onError(error); }
    }
    return targets;
  }

  async directories(): Promise<readonly DirectoryWatchTarget[]> {
    const directory = this.conversations.routing.directory;
    const targets: DirectoryWatchTarget[] = [
      { targetId: 'projects', generation: 'registry', conversationId: conversationId({ kind: 'daemon' }), kind: 'projects', directory: join(directory, 'projects') },
      { targetId: 'workspaces', generation: 'registry', conversationId: conversationId({ kind: 'daemon' }), kind: 'workspaces', directory: join(directory, 'workspaces') },
    ];
    for await (const project of this.projects()) {
      targets.push({ targetId: project.repositoryDirectory, generation: 'inbox', conversationId: project.conversationId, kind: 'inbox',
        directory: join(directory, 'manager-inbox', projectKey(project.repositoryDirectory)) });
    }
    return targets;
  }
}
