import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod/v4';
import { conversationId } from '../../infra/conversations/identity.js';
import type { InquiryNotice } from '../../core/daemon/messages.js';
import { readPrivateFile } from '../../infra/daemon/privateFile.js';
import { AsyncProcess } from '../../infra/daemon/process.js';
import type { DaemonWatchSource } from './watchers/index.js';
import type { GoalWatchTarget, RunWatchTarget, InquiryWatchTarget, LaunchWatchTarget } from './watchers/checks.js';
import type { PullRequestWatchTarget } from './watchers/pullRequests.js';
import type { DirectoryWatchTarget } from './watchers/directories.js';
import type { WatchObservations } from './watchers/observations.js';
import { listWatchEntries } from './watchers/files.js';
import { readWatchGoal, readWatchGoals, readWatchInquiries, readWatchTasks } from './watchers/state.js';
import { DaemonConversations } from './conversationState.js';
import { projectKey, routeAssignment } from './routing.js';
import { globalDaemonConfiguration, readDaemonConfiguration } from './configuration.js';
import type { DaemonPersistedFiles } from '../../infra/daemon/persistedFiles.js';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeName = (name: string): string => {
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid run slug');
  return name;
};

/** 保存ファイルから観測対象を組み立てる。 */
export class FileDaemonWatchSource implements DaemonWatchSource {
  private readonly inquiriesSeen = new Map<string, string>();
  private inquiriesInitialized = false;
  constructor(private readonly conversations: DaemonConversations,
    private readonly publish: (notice: InquiryNotice) => Promise<void>, private readonly onError: (error: unknown) => void,
    private readonly stateChanges?: WatchObservations) {}

  private async *projects() {
    for (const route of await this.conversations.routing.routes()) {
      const assignment = routeAssignment(route);
      await this.conversations.ensure(assignment);
      yield { ...route, assignment, conversationId: conversationId(assignment) };
    }
  }

  async hasWork(files: DaemonPersistedFiles): Promise<boolean> {
    for await (const project of this.projects()) {
      for await (const goal of readWatchGoals(project.repositoryDirectory, this.onError)) {
        if (goal.status !== 'completed' && goal.executionStatus !== 'aborted') return true;
      }
      if ((await listWatchEntries(await files.inboxDirectory(project.repositoryDirectory))).some((entry) => entry.isFile() && entry.name.endsWith('.json'))) return true;
      try {
        if ((await readWatchTasks(project.repositoryDirectory)).some((task) => task.status === 'pending' || task.status === 'running')) return true;
      } catch (error) { this.onError(error); }
    }
    return false;
  }

  async runs(): Promise<readonly RunWatchTarget[]> {
    const targets: RunWatchTarget[] = [];
    for await (const project of this.projects()) {
      try {
        for (const task of await readWatchTasks(project.repositoryDirectory)) {
          if (task.status !== 'running' || task.goal_id === undefined) continue;
          let goal;
          try { goal = await readWatchGoal(project.repositoryDirectory, task.goal_id); }
          catch (error) { this.onError(error); }
          let logPath: string | null = null;
          let modified = -1;
          if (task.run_slug !== undefined) {
            const executionDirectory = task.merge_task === true || task.worktree_path === undefined
              ? project.repositoryDirectory : resolve(project.repositoryDirectory, task.worktree_path);
            const logDirectory = join(executionDirectory, '.takt', 'runs', safeName(task.run_slug), 'logs');
            for (const entry of await listWatchEntries(logDirectory)) {
              if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
              const path = join(logDirectory, entry.name);
              const stamp = await stat(path);
              if (stamp.mtimeMs > modified) { logPath = path; modified = stamp.mtimeMs; }
            }
          }
          targets.push({ targetId: digest([project.repositoryDirectory, task.name]),
            generation: digest([task.run_slug, task.execution_id, task.owner_pid, task.owner_start_time]), conversationId: project.conversationId,
            task: { repositoryDirectory: project.repositoryDirectory, goalId: task.goal_id, taskName: task.name,
              ...(task.run_slug === undefined ? {} : { runSlug: task.run_slug }),
              ...(task.execution_id === undefined ? {} : { executionId: task.execution_id }) },
            owner: task.owner_pid == null ? null : { pid: task.owner_pid, startTime: task.owner_start_time ?? null },
            running: true, paused: goal?.executionStatus !== 'active', awaitingAnswer: goal?.questions?.some((question) => question.status === 'pending') === true, logPath });
        }
      } catch (error) { this.onError(error); }
    }
    return targets;
  }

  async run(targetId: string): Promise<RunWatchTarget | undefined> { return (await this.runs()).find((target) => target.targetId === targetId); }

  async pullRequests(): Promise<readonly PullRequestWatchTarget[]> {
    const targets: PullRequestWatchTarget[] = [];
    for await (const project of this.projects()) {
      try {
        for await (const goal of readWatchGoals(project.repositoryDirectory, this.onError)) {
          if (goal.pullRequest === undefined || goal.status !== 'awaiting_merge' || goal.executionStatus !== 'active') continue;
          targets.push({ targetId: digest([project.repositoryDirectory, goal.id]), generation: digest(goal.pullRequest), conversationId: project.conversationId,
            repositoryDirectory: project.repositoryDirectory, goalId: goal.id, awaitingMerge: true,
            ...goal.pullRequest, headBranch: goal.branch, baseBranch: goal.integrationBranch });
        }
      } catch (error) { this.onError(error); }
    }
    return targets;
  }

  async inquiries(): Promise<readonly InquiryWatchTarget[]> {
    const targets: InquiryWatchTarget[] = [];
    const present = new Set<string>();
    for await (const notice of this.inquiryNotices()) {
      const key = JSON.stringify([notice.conversationId, notice.target, notice.question.id]);
      present.add(key);
      const version = digest(notice.question);
      if (this.inquiriesSeen.get(key) !== version) {
        if (this.inquiriesInitialized) await this.publish(notice);
        this.inquiriesSeen.set(key, version);
      }
      const directory = notice.target.goalId !== null ? notice.target.repositoryDirectory
        : notice.target.owner.kind === 'repository' ? notice.target.owner.repositoryDirectory
          : (await this.conversations.routing.display(notice.target.owner)).repositoryDirectories[0];
      if (directory === undefined) throw new Error('Inquiry has no repository to observe');
      targets.push({ conversationId: notice.conversationId, targetId: digest([notice.conversationId, notice.target, notice.question.id]), generation: notice.question.id,
        repositoryDirectory: directory,
        questionId: notice.question.id, goalId: notice.target.goalId, pending: notice.question.status === 'pending', createdAt: notice.question.createdAt ?? null });
    }
    this.inquiriesInitialized = true;
    for (const key of this.inquiriesSeen.keys()) if (!present.has(key)) this.inquiriesSeen.delete(key);
    return targets;
  }

  async goals(): Promise<readonly GoalWatchTarget[]> {
    const targets: GoalWatchTarget[] = [];
    for await (const project of this.projects()) {
      try {
        const tasks = await readWatchTasks(project.repositoryDirectory);
        for await (const goal of readWatchGoals(project.repositoryDirectory, this.onError)) {
          const dates = [goal.createdAt, ...goal.workLog.filter((entry) => entry.kind !== 'patrol').map((entry) => entry.recordedAt),
            ...(goal.questions ?? []).flatMap((question) => [question.createdAt, question.answer?.answeredAt, question.withdrawnAt])]
            .filter((date): date is string => date !== undefined).sort((left, right) => Date.parse(left) - Date.parse(right));
          if (dates.length === 0) continue;
          const lastUpdatedAt = dates.at(-1)!;
          targets.push({ targetId: digest([project.repositoryDirectory, goal.id]), generation: digest([goal.id, lastUpdatedAt]), conversationId: project.conversationId,
            repositoryDirectory: project.repositoryDirectory, goalId: goal.id, active: goal.executionStatus === 'active' && goal.status !== 'completed' && goal.status !== 'awaiting_merge'
              && !goal.questions?.some((question) => question.status === 'pending' && question.recipient === 'human')
              && !tasks.some((task) => task.goal_id === goal.id && task.status === 'running'), lastUpdatedAt });
        }
      } catch (error) { this.onError(error); }
    }
    return targets;
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
        for await (const goal of readWatchGoals(project.repositoryDirectory, this.onError)) {
          await this.directorChanged(project.conversationId, project.repositoryDirectory, goal.id, { status: goal.status, executionStatus: goal.executionStatus,
            blockedNotifications: (goal.notifications ?? []).filter((notification) => notification.kind === 'blocked').map((notification) => notification.id).sort(),
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
            const goal = await readWatchGoal(project.repositoryDirectory, task.goal_id);
            if (goal.status === 'created' && goal.executionStatus === 'active') pending.push(task);
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
