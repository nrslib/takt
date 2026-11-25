import type { TurnEvent } from './events.js';

export function assertDirectorManagerHumanMessage(event: TurnEvent, repositoryDirectory: string): void {
  if (event.kind !== 'human_command' || event.command.kind !== 'message') {
    throw new Error('Manager preparation requires a human message turn');
  }
  const directoryPattern = repositoryDirectory.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const suppliedDirectory = new RegExp(`(?:^|[\\s"'\x60「『(（])${directoryPattern}(?=\\.?(?:$|[\\s"'\x60」』)）]))`, 'u');
  if (!suppliedDirectory.test(event.command.text)) {
    throw new Error('Manager preparation requires a repository path supplied in the human message');
  }
}
