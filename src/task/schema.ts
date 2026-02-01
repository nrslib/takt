/**
 * Task YAML schema definition
 *
 * Zod schema for structured task files (.yaml/.yml)
 */

import { z } from 'zod/v4';

/**
 * YAML task file schema
 *
 * Examples:
 *   task: "認証機能を追加する"
 *   worktree: true                  # 共有クローンで隔離実行
 *   branch: "feat/add-auth"         # オプション（省略時は自動生成）
 *   workflow: "default"             # オプション（省略時はcurrent workflow）
 *
 * worktree patterns (uses git clone --shared internally):
 *   - true: create shared clone in sibling dir or worktree_dir
 *   - "/path/to/dir": create at specified path
 *   - omitted: no isolation (run in cwd)
 *
 * branch patterns:
 *   - "feat/xxx": use specified branch name
 *   - omitted: auto-generate as takt/{timestamp}-{task-slug}
 */
export const TaskFileSchema = z.object({
  task: z.string().min(1),
  worktree: z.union([z.boolean(), z.string()]).optional(),
  branch: z.string().optional(),
  workflow: z.string().optional(),
  issue: z.number().int().positive().optional(),
});

export type TaskFileData = z.infer<typeof TaskFileSchema>;
