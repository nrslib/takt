<!-- markdownlint-disable MD041 -->
<!--
  template: sync_conflict_resolver_message
  role: user message for sync conflict resolver agent
  vars: originalInstruction
  caller: features/tasks/list/taskSyncAction.ts
-->
Git merge has stopped due to merge conflicts.

## Procedure

### 1. Identify conflicts

Run `git status` to list unmerged files.

### 2. Understand context

Run these in parallel:
- `git log --oneline HEAD -5` to see recent HEAD changes
- `git log --oneline MERGE_HEAD -5` to see incoming changes (if merge)

### 3. Analyze each conflicted file

For each file:
1. Read the full file (with conflict markers)
2. For each conflict block (`<<<<<<<` to `>>>>>>>`):
   - Read HEAD side content
   - Read theirs side content
   - Determine what the diff means (version bump? refactor? feature addition?)
   - If unclear, check `git log --oneline -- {file}`
3. Write your judgment before resolving

### 4. Resolve

- If one side is clearly correct: read it with `git show ':2:path/to/file'` (ours) or `git show ':3:path/to/file'` (theirs), then save that content with a file-editing tool. If the chosen side deleted the file, remove the conflicted file instead.
- If both changes need merging: edit the file to combine both sides
- Save the resolved content in each conflicted file. Do not change the Git index.

After resolving, search for `<<<<<<<` to ensure no markers remain.

### 5. Verify

- Run build/test if available
- Check that non-conflicted files are consistent with the resolution

### 6. Hand the resolution to TAKT

Report your reasoning and edits. TAKT validates the files, stages them, and completes the merge commit.

## Original task

{{originalInstruction}}
