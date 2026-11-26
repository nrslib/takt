import type { TurnEvent } from './events.js';

export function assertDirectorManagerHumanMessage(event: TurnEvent): void {
  if (event.kind !== 'human_command' || event.command.kind !== 'message') {
    throw new Error('Manager preparation requires a human message turn');
  }
}
