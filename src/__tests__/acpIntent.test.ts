import { describe, expect, it } from 'vitest';
import { resolveAcpPromptIntent } from '../app/acp/intent.js';
import type { AcpDefaultAction } from '../app/acp/types.js';

describe('ACP prompt intent resolver', () => {
  it.each([
    ['この内容をタスクに積んで', 'enqueue'],
    ['pending task にして', 'enqueue'],
    ['後で takt run する', 'enqueue'],
    ['worktree で実行できるように積んで', 'enqueue'],
    ['Please put this in the task queue', 'enqueue'],
    ['make it a pending task', 'enqueue'],
    ['Issueを作ってタスクに積んで', 'create_issue_and_enqueue'],
    ['Issueを作ってタスクに積む', 'create_issue_and_enqueue'],
    ['GitHub Issue を作ってタスクに積んで', 'create_issue_and_enqueue'],
    ['create an issue and enqueue', 'create_issue_and_enqueue'],
    ['create issue and make it a pending task', 'create_issue_and_enqueue'],
    ['そのまま実行して', 'direct'],
    ['今すぐ実行して', 'direct'],
    ['run it now', 'direct'],
    ['execute now', 'direct'],
    ['Use direct execution', 'direct'],
  ] as const)('should resolve explicit task instruction: %s', (text, action) => {
    expect(resolveAcpPromptIntent(text, 'enqueue')).toEqual({
      kind: 'task_instruction',
      action,
      userNote: text,
      userNoteSource: 'acp',
    });
  });

  it.each([
    ['/go include progress updates', 'enqueue'],
    ['/go include progress updates', 'direct'],
  ] as Array<[string, AcpDefaultAction]>)('should resolve /go with the session default action: %s %s', (text, defaultAction) => {
    expect(resolveAcpPromptIntent(text, defaultAction)).toEqual({
      kind: 'task_instruction',
      action: defaultAction,
      userNote: 'include progress updates',
      userNoteSource: 'go',
    });
  });

  it.each([
    'この修正方針を相談したい',
    '今すぐ実行していいか相談したい',
    '今すぐ実行してという方針を相談したい',
    'Should I run it now?',
    'I want to ask about direct execution',
    'タスクに積んでいいか相談したい',
    'タスクに積んでという方針を相談したい',
    'Issueを作ってタスクに積んでいいか相談したい',
    'task queueについて教えて',
    'task queueとは何ですか',
    'What is a task queue?',
  ])('should keep ambiguous or advisory instruction text in conversation: %s', (text) => {
    expect(resolveAcpPromptIntent(text, 'enqueue')).toEqual({
      kind: 'conversation',
    });
  });

  it('should enqueue mixed text when the direct phrase is negated', () => {
    const text = '今すぐ実行してではなくタスクに積んで';

    expect(resolveAcpPromptIntent(text, 'enqueue')).toEqual({
      kind: 'task_instruction',
      action: 'enqueue',
      userNote: text,
      userNoteSource: 'acp',
    });
  });

  it('should prefer direct when enqueue and direct are both positively explicit', () => {
    const text = 'タスクに積んで。今すぐ実行して';

    expect(resolveAcpPromptIntent(text, 'enqueue')).toEqual({
      kind: 'task_instruction',
      action: 'direct',
      userNote: text,
      userNoteSource: 'acp',
    });
  });

  it.each([
    ['/go 監査ログを追加してタスクに積んで', 'go', 'enqueue'],
    ['監査ログを追加して /go', 'go', 'enqueue'],
    ['監査ログを追加して /go の説明も含めてタスクに積んで', 'acp', 'enqueue'],
    ['監査ログのIssueを作ってタスクに積んで', 'acp', 'create_issue_and_enqueue'],
    ['監査ログのIssueを作ってタスクに積んで。/go の説明も含めて', 'acp', 'create_issue_and_enqueue'],
  ] as const)('keeps the actual entry source for %s', (text, userNoteSource, action) => {
    expect(resolveAcpPromptIntent(text, 'enqueue')).toMatchObject({ kind: 'task_instruction', userNoteSource, action });
  });
});
