import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { conversationId } from '../../infra/conversations/identity.js';
import type { InquiryNotice } from '../../core/daemon/messages.js';
import { readPrivateFile } from '../../infra/daemon/privateFile.js';
import { AsyncProcess } from '../../infra/daemon/process.js';
import type { DaemonWatchSource } from './watchers/index.js';
import type { GoalWatchTarget, RunWatchTarget, InquiryWatchTarget, LaunchWatchTarget } from './watchers/checks.js';
import type { PullRequestWatchTarget } from './watchers/pullRequests.js';
import type { DirectoryWatchTarget } from './watchers/directories.js';
import { boundWatchTargets } from './watchers/checks.js';
import { listWatchEntries } from './watchers/files.js';
import { readWatchGoals, readWatchInquiries, readWatchTasks } from './watchers/state.js';
import { DaemonConversations } from './conversationState.js';
import { projectKey, routeAssignment } from './routing.js';
import { globalDaemonConfiguration, readDaemonConfiguration } from './configuration.js';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeName = (name: string): string => {
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid run slug');
  return name;
};

/** 小さい保存ファイルから、上限付きの観測対象だけを組み立てる。 */
export class FileDaemonWatchSource implements DaemonWatchSource {
  private readonly inquiriesSeen = new Map<string, string>();
  constructor(private readonly conversations: DaemonConversations,
    private readonly publish: (notice: InquiryNotice) => Promise<void>, private readonly onError: (error: unknown) => void) {}

  private async *projects() {
    for (const route of await this.conversations.routing.routes()) {
      const assignment = routeAssignment(route);
      await this.conversations.ensure(assignment);
      yield { ...route, assignment, conversationId: conversationId(assignment) };
    }
  }

  async runs(): Promise<readonly RunWatchTarget[]> {
    const targets: RunWatchTarget[] = [];
    for await (const project of this.projects()) {
      const goals = await readWatchGoals(project.repositoryDirectory, this.onError);
      for (const task of await readWatchTasks(project.repositoryDirectory)) {
        if (task.status !== 'running' || task.goal_id === undefined || task.run_slug === undefined) continue;
        const goal = goals.find((entry) => entry.id === task.goal_id);
        const logDirectory = join(project.repositoryDirectory, '.takt', 'runs', safeName(task.run_slug), 'logs');
        let logPath: string | null = null;
        let modified = -1;
        for (const entry of await listWatchEntries(logDirectory)) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const path = join(logDirectory, entry.name);
          const stamp = await stat(path);
          if (stamp.mtimeMs > modified) { logPath = path; modified = stamp.mtimeMs; }
        }
        targets.push({ targetId: digest([project.repositoryDirectory, task.name]),
          generation: digest([task.run_slug, task.execution_id, task.owner_pid, task.owner_start_time]), conversationId: project.conversationId,
          task: { repositoryDirectory: project.repositoryDirectory, goalId: task.goal_id, taskName: task.name, runSlug: task.run_slug,
            ...(task.execution_id === undefined ? {} : { executionId: task.execution_id }) },
          owner: task.owner_pid == null || task.owner_start_time == null ? null : { pid: task.owner_pid, startTime: task.owner_start_time },
          running: true, paused: goal?.executionStatus !== 'active', awaitingAnswer: goal?.questions?.some((question) => question.status === 'pending') === true, logPath });
        boundWatchTargets(targets);
      }
    }
    return targets;
  }

  async run(targetId: string): Promise<RunWatchTarget | undefined> { return (await this.runs()).find((target) => target.targetId === targetId); }

  async pullRequests(): Promise<readonly PullRequestWatchTarget[]> {
    const targets: PullRequestWatchTarget[] = [];
    for await (const project of this.projects()) {
      for (const goal of await readWatchGoals(project.repositoryDirectory, this.onError)) {
        if (goal.pullRequest === undefined || goal.status !== 'awaiting_merge' || goal.executionStatus !== 'active') continue;
        targets.push({ targetId: digest([project.repositoryDirectory, goal.id]), generation: digest(goal.pullRequest), conversationId: project.conversationId,
          repositoryDirectory: project.repositoryDirectory, goalId: goal.id, awaitingMerge: true,
          ...goal.pullRequest, headBranch: goal.branch, baseBranch: goal.integrationBranch });
        boundWatchTargets(targets);
      }
    }
    return targets;
  }

  async inquiries(): Promise<readonly InquiryWatchTarget[]> {
    const targets: InquiryWatchTarget[] = [];
    for (const notice of await this.inquiryNotices()) {
      const directory = notice.target.goalId !== null ? notice.target.repositoryDirectory
        : notice.target.owner.kind === 'repository' ? notice.target.owner.repositoryDirectory
          : (await this.conversations.routing.display(notice.target.owner)).repositoryDirectories[0];
      if (directory === undefined) throw new Error('Inquiry has no repository to observe');
      targets.push({ conversationId: notice.conversationId, targetId: digest([notice.conversationId, notice.target, notice.question.id]), generation: notice.question.id,
        repositoryDirectory: directory,
        questionId: notice.question.id, goalId: notice.target.goalId, pending: notice.question.status === 'pending', createdAt: notice.question.createdAt ?? null });
      boundWatchTargets(targets);
    }
    return targets;
  }

  async goals(): Promise<readonly GoalWatchTarget[]> {
    const targets: GoalWatchTarget[] = [];
    for await (const project of this.projects()) {
      for (const goal of await readWatchGoals(project.repositoryDirectory, this.onError)) {
        const dates = [goal.createdAt, ...goal.workLog.map((entry) => entry.recordedAt), ...(goal.notifications ?? []).map((entry) => entry.recordedAt),
          ...(goal.questions ?? []).flatMap((question) => [question.createdAt, question.answer?.answeredAt, question.withdrawnAt])]
          .filter((date): date is string => date !== undefined).sort((left, right) => Date.parse(left) - Date.parse(right));
        if (dates.length === 0) continue;
        const lastUpdatedAt = dates.at(-1)!;
        targets.push({ targetId: digest([project.repositoryDirectory, goal.id]), generation: digest([goal.id, lastUpdatedAt]), conversationId: project.conversationId,
          repositoryDirectory: project.repositoryDirectory, goalId: goal.id, active: goal.executionStatus === 'active' && goal.status !== 'completed', lastUpdatedAt });
        boundWatchTargets(targets);
      }
    }
    return targets;
  }

  private async inquiryNotices(): Promise<InquiryNotice[]> {
    const notices: InquiryNotice[] = [];
    const assignments = new Map<string, { assignment: Exclude<import('../../infra/conversations/schema.js').ConversationAssignment, { kind: 'daemon' }>; directory: string }>();
    for await (const project of this.projects()) {
      const { assignment } = project;
      if (assignment.kind === 'daemon') throw new Error('Manager assignment required');
      assignments.set(project.conversationId, { assignment, directory: assignment.kind === 'workspace'
        ? join(this.conversations.routing.directory, 'workspaces', assignment.workspaceId, 'inquiries')
        : join(this.conversations.routing.directory, 'projects', projectKey(project.repositoryDirectory), 'inquiries') });
      for (const goal of await readWatchGoals(project.repositoryDirectory, this.onError)) {
        for (const question of goal.questions ?? []) {
          notices.push({ conversationId: project.conversationId, target: { goalId: goal.id, repositoryDirectory: project.repositoryDirectory }, question });
          boundWatchTargets(notices);
        }
      }
    }
    for (const [id, { assignment, directory }] of assignments) {
      for (const question of await readWatchInquiries(directory)) {
        notices.push({ conversationId: id, target: { goalId: null, owner: assignment }, question });
        boundWatchTargets(notices);
      }
    }
    return notices;
  }

  async launches(): Promise<readonly LaunchWatchTarget[]> {
    const targets: LaunchWatchTarget[] = [];
    const global = await globalDaemonConfiguration(this.conversations.routing.directory);
    for await (const project of this.projects()) {
      const tasks = await readWatchTasks(project.repositoryDirectory);
      const goals = await readWatchGoals(project.repositoryDirectory, this.onError);
      const pending = tasks.filter((task) => task.status === 'pending' && goals.some((goal) => goal.id === task.goal_id
        && goal.status === 'created' && goal.executionStatus === 'active'));
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
      boundWatchTargets(targets);
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
      boundWatchTargets(targets);
    }
    const present = new Set<string>();
    for (const notice of await this.inquiryNotices()) {
      const key = JSON.stringify([notice.conversationId, notice.target, notice.question.id]);
      present.add(key);
      const version = digest(notice.question);
      if (this.inquiriesSeen.get(key) === version) continue;
      await this.publish(notice);
      this.inquiriesSeen.set(key, version);
    }
    for (const key of this.inquiriesSeen.keys()) if (!present.has(key)) this.inquiriesSeen.delete(key);
    return targets;
  }
}
