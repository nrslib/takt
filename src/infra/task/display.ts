/**
 * Task display utilities
 *
 * UI/表示に関する関数を分離
 */

import chalk from 'chalk';
import { header, info, divider } from '../../shared/ui/index.js';
import type { TaskRunner } from './runner.js';

/**
 * タスク一覧を表示
 */
export function showTaskList(runner: TaskRunner): void {
  const tasks = runner.listTasks();

  console.log();
  divider('=', 60);
  header('TAKT タスク一覧');
  divider('=', 60);
  console.log(chalk.gray(`タスクディレクトリ: ${runner.getTasksDir()}`));
  divider('-', 60);

  if (tasks.length === 0) {
    console.log();
    info('実行待ちのタスクはありません。');
    console.log(chalk.gray(`\n${runner.getTasksDir()} を確認してください。`));
    console.log(chalk.gray('takt add でタスクを追加できます。'));
    return;
  }

  console.log(chalk.green(`\n${tasks.length} 個のタスクがあります:\n`));

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (task) {
      // タスク内容の最初の行を取得
      const firstLine = task.content.trim().split('\n')[0]?.slice(0, 60) ?? '';
      console.log(chalk.cyan.bold(`  [${i + 1}] ${task.name}`));
      console.log(chalk.gray(`      ${firstLine}...`));

      if (task.data) {
        const extras: string[] = [];
        if (task.data.worktree) {
          extras.push(`worktree: ${typeof task.data.worktree === 'string' ? task.data.worktree : 'auto'}`);
        }
        if (task.data.branch) {
          extras.push(`branch: ${task.data.branch}`);
        }
        if (task.data.piece) {
          extras.push(`piece: ${task.data.piece}`);
        }
        if (extras.length > 0) {
          console.log(chalk.dim(`      [${extras.join(', ')}]`));
        }
      }
    }
  }

  console.log();
  divider('=', 60);
  console.log(chalk.yellow.bold('使用方法:'));
  console.log(chalk.gray('  /add-task           タスクを追加'));
  console.log(chalk.gray('  /task run           次のタスクを実行'));
  console.log(chalk.gray('  /task run <name>    指定したタスクを実行'));
}
