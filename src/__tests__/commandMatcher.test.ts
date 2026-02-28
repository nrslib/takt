/**
 * Unit tests for the slash command parser.
 *
 * Verifies command detection at the beginning and end of input,
 * and ensures commands in the middle of text are not recognized.
 */

import { describe, it, expect } from 'vitest';
import { matchSlashCommand } from '../features/interactive/commandMatcher.js';

// =================================================================
// Start-of-line detection (existing behavior)
// =================================================================
describe('start-of-line detection', () => {
  it('should detect /play with task text', () => {
    const result = matchSlashCommand('/play fix the login bug');
    expect(result).toEqual({ command: '/play', text: 'fix the login bug' });
  });

  it('should detect /play without task text', () => {
    const result = matchSlashCommand('/play');
    expect(result).toEqual({ command: '/play', text: '' });
  });

  it('should detect /go without note', () => {
    const result = matchSlashCommand('/go');
    expect(result).toEqual({ command: '/go', text: '' });
  });

  it('should detect /go with user note', () => {
    const result = matchSlashCommand('/go also check security');
    expect(result).toEqual({ command: '/go', text: 'also check security' });
  });

  it('should detect /cancel', () => {
    const result = matchSlashCommand('/cancel');
    expect(result).toEqual({ command: '/cancel', text: '' });
  });

  it('should detect /retry', () => {
    const result = matchSlashCommand('/retry');
    expect(result).toEqual({ command: '/retry', text: '' });
  });

  it('should detect /replay', () => {
    const result = matchSlashCommand('/replay');
    expect(result).toEqual({ command: '/replay', text: '' });
  });

  it('should detect /resume', () => {
    const result = matchSlashCommand('/resume');
    expect(result).toEqual({ command: '/resume', text: '' });
  });
});

// =================================================================
// End-of-line detection (new behavior)
// =================================================================
describe('end-of-line detection', () => {
  it('should detect /play at the end with preceding text as task', () => {
    const result = matchSlashCommand('fix the login bug /play');
    expect(result).toEqual({ command: '/play', text: 'fix the login bug' });
  });

  it('should detect /go at the end with preceding text as user note', () => {
    const result = matchSlashCommand('ここまでの内容で実行して /go');
    expect(result).toEqual({ command: '/go', text: 'ここまでの内容で実行して' });
  });

  it('should detect /go at the end without preceding text', () => {
    const result = matchSlashCommand('some text /go');
    expect(result).toEqual({ command: '/go', text: 'some text' });
  });

  it('should detect /cancel at the end', () => {
    const result = matchSlashCommand('やっぱりやめる /cancel');
    expect(result).toEqual({ command: '/cancel', text: 'やっぱりやめる' });
  });

  it('should detect /retry at the end', () => {
    const result = matchSlashCommand('もう一回 /retry');
    expect(result).toEqual({ command: '/retry', text: 'もう一回' });
  });

  it('should detect /replay at the end', () => {
    const result = matchSlashCommand('再実行して /replay');
    expect(result).toEqual({ command: '/replay', text: '再実行して' });
  });

  it('should detect /resume at the end', () => {
    const result = matchSlashCommand('セッション復元 /resume');
    expect(result).toEqual({ command: '/resume', text: 'セッション復元' });
  });
});

// =================================================================
// Middle-of-text: NOT recognized
// =================================================================
describe('middle-of-text (not recognized)', () => {
  it('should not detect /go in the middle of text', () => {
    const result = matchSlashCommand('テキスト中に /go を含むがコマンドではない文');
    expect(result).toBeNull();
  });

  it('should not detect /play in the middle of text', () => {
    const result = matchSlashCommand('I want to /play around with the code later');
    expect(result).toBeNull();
  });

  it('should not detect /cancel in the middle of text', () => {
    const result = matchSlashCommand('we should /cancel the order and redo');
    expect(result).toBeNull();
  });

  it('should not detect /retry in the middle of text', () => {
    const result = matchSlashCommand('lets /retry that approach first');
    expect(result).toBeNull();
  });

  it('should not detect /replay in the middle of text', () => {
    expect(matchSlashCommand('please /replay the scenario')).toBeNull();
  });

  it('should not detect /resume in the middle of text', () => {
    expect(matchSlashCommand('I want to /resume the work now')).toBeNull();
  });
});

// =================================================================
// Edge cases
// =================================================================
describe('edge cases', () => {
  it('should return null for empty input', () => {
    expect(matchSlashCommand('')).toBeNull();
  });

  it('should return null for regular text without commands', () => {
    expect(matchSlashCommand('hello world')).toBeNull();
  });

  it('should not match command without space separator at end', () => {
    expect(matchSlashCommand('text/go')).toBeNull();
  });

  it('should not match unknown slash command', () => {
    expect(matchSlashCommand('/unknown')).toBeNull();
  });

  it('should not match unknown slash command at end', () => {
    expect(matchSlashCommand('text /unknown')).toBeNull();
  });

  it('should prioritize start-of-line over end-of-line', () => {
    const result = matchSlashCommand('/go /cancel');
    expect(result).toEqual({ command: '/go', text: '/cancel' });
  });

  it('should handle multiple spaces between text and end command', () => {
    const result = matchSlashCommand('text  /go');
    expect(result).toEqual({ command: '/go', text: 'text' });
  });

  it('should handle /play with extra spaces in task', () => {
    const result = matchSlashCommand('/play  fix  the  bug');
    expect(result).toEqual({ command: '/play', text: 'fix  the  bug' });
  });

  it('should not match /go followed by characters without space', () => {
    expect(matchSlashCommand('/goextra')).toBeNull();
  });

  it('should not match /play as prefix of another word', () => {
    expect(matchSlashCommand('/playing around')).toBeNull();
  });

  it('should not match partial command at end of input', () => {
    expect(matchSlashCommand('text /gopher')).toBeNull();
  });

  it('should not match case-insensitive commands', () => {
    expect(matchSlashCommand('/Go')).toBeNull();
    expect(matchSlashCommand('/PLAY')).toBeNull();
    expect(matchSlashCommand('/Cancel')).toBeNull();
  });

  it('should not match slash only', () => {
    expect(matchSlashCommand('/')).toBeNull();
  });

  it('should not match slash with space before command name', () => {
    expect(matchSlashCommand('/ go')).toBeNull();
  });

  it('should match last command when multiple commands at end', () => {
    const result = matchSlashCommand('text /go /cancel');
    expect(result).toEqual({ command: '/cancel', text: 'text /go' });
  });
});
