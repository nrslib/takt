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
