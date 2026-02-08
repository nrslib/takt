/**
 * TAKT タスク実行モード
 *
 * .takt/tasks/ ディレクトリ内のタスクファイルを読み込み、
 * 順番に実行してレポートを生成する。
 *
 * Supports both .md (plain text) and .yaml/.yml (structured) task files.
 *
 * 使用方法:
 *   /task                     # タスク一覧を表示
 *   /task run                 # 次のタスクを実行
 *   /task run <filename>      # 指定したタスクを実行
 *   /task list                # タスク一覧を表示
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseTaskFiles, parseTaskFile, type ParsedTask } from './parser.js';
import type { TaskInfo, TaskResult, TaskListItem } from './types.js';
import { createLogger } from '../../shared/utils/index.js';

export type { TaskInfo, TaskResult, TaskListItem };

const log = createLogger('task-runner');

/**
 * タスク実行管理クラス
 */
export class TaskRunner {
  private projectDir: string;
  private tasksDir: string;
  private completedDir: string;
  private failedDir: string;
  private claimedPaths = new Set<string>();

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.tasksDir = path.join(projectDir, '.takt', 'tasks');
    this.completedDir = path.join(projectDir, '.takt', 'completed');
    this.failedDir = path.join(projectDir, '.takt', 'failed');
  }

  /** ディレクトリ構造を作成 */
  ensureDirs(): void {
    fs.mkdirSync(this.tasksDir, { recursive: true });
    fs.mkdirSync(this.completedDir, { recursive: true });
    fs.mkdirSync(this.failedDir, { recursive: true });
  }

  /** タスクディレクトリのパスを取得 */
  getTasksDir(): string {
    return this.tasksDir;
  }

  /**
   * タスク一覧を取得
   * @returns タスク情報のリスト（ファイル名順）
   */
  listTasks(): TaskInfo[] {
    this.ensureDirs();

    try {
      const parsed = parseTaskFiles(this.tasksDir);
      return parsed.map(toTaskInfo);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ENOENT') {
        throw err; // 予期しないエラーは再スロー
      }
      // ENOENT は許容（ディレクトリ未作成）
      return [];
    }
  }

  /**
   * 指定した名前のタスクを取得
   * Searches for .yaml, .yml, and .md files in that order.
   */
  getTask(name: string): TaskInfo | null {
    this.ensureDirs();

    const extensions = ['.yaml', '.yml', '.md'];

    for (const ext of extensions) {
      const filePath = path.join(this.tasksDir, `${name}${ext}`);
      if (!fs.existsSync(filePath)) {
        continue;
      }

      try {
        const parsed = parseTaskFile(filePath);
        return toTaskInfo(parsed);
      } catch {
        // Parse error: skip this extension
      }
    }

    return null;
  }

  /**
   * 次に実行すべきタスクを取得（最初のタスク）
   */
  getNextTask(): TaskInfo | null {
    const tasks = this.listTasks();
    return tasks[0] ?? null;
  }

  /**
   * 予約付きタスク取得
   *
   * claimed 済みのタスクを除外して返し、返したタスクを claimed に追加する。
   * 並列実行時に同一タスクが複数ワーカーに返されることを防ぐ。
   */
  claimNextTasks(count: number): TaskInfo[] {
    const allTasks = this.listTasks();
    const unclaimed = allTasks.filter((t) => !this.claimedPaths.has(t.filePath));
    const claimed = unclaimed.slice(0, count);
    for (const task of claimed) {
      this.claimedPaths.add(task.filePath);
    }
    return claimed;
  }

  /**
   * タスクを完了としてマーク
   *
   * タスクファイルを .takt/completed に移動し、
   * レポートファイルを作成する。
   *
   * @returns レポートファイルのパス
   */
  completeTask(result: TaskResult): string {
    if (!result.success) {
      throw new Error('Cannot complete a failed task. Use failTask() instead.');
    }
    return this.moveTask(result, this.completedDir);
  }

  /**
   * タスクを失敗としてマーク
   *
   * タスクファイルを .takt/failed に移動し、
   * レポートファイルを作成する。
   *
   * @returns レポートファイルのパス
   */
  failTask(result: TaskResult): string {
    return this.moveTask(result, this.failedDir);
  }

  /**
   * pendingタスクを TaskListItem 形式で取得
   */
  listPendingTaskItems(): TaskListItem[] {
    return this.listTasks().map((task) => ({
      kind: 'pending' as const,
      name: task.name,
      createdAt: task.createdAt,
      filePath: task.filePath,
      content: task.content.trim().split('\n')[0]?.slice(0, 80) ?? '',
    }));
  }

  /**
   * failedタスクの一覧を取得
   * .takt/failed/ 内のサブディレクトリを走査し、TaskListItem を返す
   */
  listFailedTasks(): TaskListItem[] {
    this.ensureDirs();

    const entries = fs.readdirSync(this.failedDir);

    return entries
      .filter((entry) => {
        const entryPath = path.join(this.failedDir, entry);
        return fs.statSync(entryPath).isDirectory() && entry.includes('_');
      })
      .map((entry) => {
        const entryPath = path.join(this.failedDir, entry);
        const underscoreIdx = entry.indexOf('_');
        const timestampRaw = entry.slice(0, underscoreIdx);
        const name = entry.slice(underscoreIdx + 1);
        const createdAt = timestampRaw.replace(
          /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})$/,
          '$1:$2:$3',
        );
        const content = this.readFailedTaskContent(entryPath);
        return { kind: 'failed' as const, name, createdAt, filePath: entryPath, content };
      })
      .filter((item) => item.name !== '');
  }

  /**
   * failedタスクディレクトリ内のタスクファイルから先頭1行を読み取る
   */
  private readFailedTaskContent(dirPath: string): string {
    const taskExtensions = ['.md', '.yaml', '.yml'];
    let files: string[];
    try {
      files = fs.readdirSync(dirPath);
    } catch (err) {
      log.error('Failed to read failed task directory', { dirPath, error: String(err) });
      return '';
    }

    for (const file of files) {
      const ext = path.extname(file);
      if (file === 'report.md' || file === 'log.json') continue;
      if (!taskExtensions.includes(ext)) continue;

      try {
        const raw = fs.readFileSync(path.join(dirPath, file), 'utf-8');
        return raw.trim().split('\n')[0]?.slice(0, 80) ?? '';
      } catch (err) {
        log.error('Failed to read failed task file', { file, dirPath, error: String(err) });
        continue;
      }
    }

    return '';
  }

  /**
   * Requeue a failed task back to .takt/tasks/
   *
   * Copies the task file from failed directory to tasks directory.
   * If startMovement is specified and the task is YAML, adds start_movement field.
   * If retryNote is specified and the task is YAML, adds retry_note field.
   * Original failed directory is preserved for history.
   *
   * @param failedTaskDir - Path to failed task directory (e.g., .takt/failed/2026-01-31T12-00-00_my-task/)
   * @param startMovement - Optional movement to start from (written to task file)
   * @param retryNote - Optional note about why task is being retried (written to task file)
   * @returns The path to the requeued task file
   * @throws Error if task file not found or copy fails
   */
  requeueFailedTask(failedTaskDir: string, startMovement?: string, retryNote?: string): string {
    this.ensureDirs();

    // Find task file in failed directory
    const taskExtensions = ['.yaml', '.yml', '.md'];
    let files: string[];
    try {
      files = fs.readdirSync(failedTaskDir);
    } catch (err) {
      throw new Error(`Failed to read failed task directory: ${failedTaskDir} - ${err}`);
    }

    let taskFile: string | null = null;
    let taskExt: string | null = null;

    for (const file of files) {
      const ext = path.extname(file);
      if (file === 'report.md' || file === 'log.json') continue;
      if (!taskExtensions.includes(ext)) continue;
      taskFile = path.join(failedTaskDir, file);
      taskExt = ext;
      break;
    }

    if (!taskFile || !taskExt) {
      throw new Error(`No task file found in failed directory: ${failedTaskDir}`);
    }

    // Read task content
    const taskContent = fs.readFileSync(taskFile, 'utf-8');
    const taskName = path.basename(taskFile, taskExt);

    // Destination path
    const destFile = path.join(this.tasksDir, `${taskName}${taskExt}`);

    // For YAML files, add start_movement and retry_note if specified
    let finalContent = taskContent;
    if (taskExt === '.yaml' || taskExt === '.yml') {
      if (startMovement) {
        // Check if start_movement already exists
        if (!/^start_movement:/m.test(finalContent)) {
          // Add start_movement field at the end
          finalContent = finalContent.trimEnd() + `\nstart_movement: ${startMovement}\n`;
        } else {
          // Replace existing start_movement
          finalContent = finalContent.replace(/^start_movement:.*$/m, `start_movement: ${startMovement}`);
        }
      }

      if (retryNote) {
        // Escape double quotes in retry note for YAML string
        const escapedNote = retryNote.replace(/"/g, '\\"');
        // Check if retry_note already exists
        if (!/^retry_note:/m.test(finalContent)) {
          // Add retry_note field at the end
          finalContent = finalContent.trimEnd() + `\nretry_note: "${escapedNote}"\n`;
        } else {
          // Replace existing retry_note
          finalContent = finalContent.replace(/^retry_note:.*$/m, `retry_note: "${escapedNote}"`);
        }
      }
    }

    // Write to tasks directory
    fs.writeFileSync(destFile, finalContent, 'utf-8');

    log.info('Requeued failed task', { from: failedTaskDir, to: destFile, startMovement });

    return destFile;
  }

  /**
   * タスクファイルを指定ディレクトリに移動し、レポート・ログを生成する
   */
  private moveTask(result: TaskResult, targetDir: string): string {
    this.ensureDirs();

    // タイムスタンプを生成
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    // ターゲットディレクトリにサブディレクトリを作成
    const taskTargetDir = path.join(
      targetDir,
      `${timestamp}_${result.task.name}`
    );
    fs.mkdirSync(taskTargetDir, { recursive: true });

    // 元のタスクファイルを移動（元の拡張子を保持）
    const originalExt = path.extname(result.task.filePath);
    const movedTaskFile = path.join(taskTargetDir, `${result.task.name}${originalExt}`);
    fs.renameSync(result.task.filePath, movedTaskFile);

    this.claimedPaths.delete(result.task.filePath);

    // レポートを生成
    const reportFile = path.join(taskTargetDir, 'report.md');
    const reportContent = this.generateReport(result);
    fs.writeFileSync(reportFile, reportContent, 'utf-8');

    // ログを保存
    const logFile = path.join(taskTargetDir, 'log.json');
    const logData = {
      taskName: result.task.name,
      success: result.success,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      executionLog: result.executionLog,
      response: result.response,
    };
    fs.writeFileSync(logFile, JSON.stringify(logData, null, 2), 'utf-8');

    return reportFile;
  }

  /**
   * レポートを生成
   */
  private generateReport(result: TaskResult): string {
    const status = result.success ? '成功' : '失敗';

    return `# タスク実行レポート

## 基本情報

- タスク名: ${result.task.name}
- ステータス: ${status}
- 開始時刻: ${result.startedAt}
- 完了時刻: ${result.completedAt}

## 元のタスク

\`\`\`markdown
${result.task.content}
\`\`\`

## 実行結果

${result.response}

---

*Generated by TAKT Task Runner*
`;
  }
}

/** Convert ParsedTask to TaskInfo */
function toTaskInfo(parsed: ParsedTask): TaskInfo {
  return {
    filePath: parsed.filePath,
    name: parsed.name,
    content: parsed.content,
    createdAt: parsed.createdAt,
    data: parsed.data,
  };
}
