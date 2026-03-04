export function assertTaskPrefixPair(
  taskPrefix: string | undefined,
  taskColorIndex: number | undefined,
): void {
  if ((taskPrefix != null) !== (taskColorIndex != null)) {
    throw new Error('taskPrefix and taskColorIndex must be provided together');
  }
}

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength) + '...';
}

export function formatElapsedTime(startTime: string, endTime: string): string {
  const elapsedSec = (new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000;
  if (elapsedSec < 60) {
    return `${elapsedSec.toFixed(1)}s`;
  }
  return `${Math.floor(elapsedSec / 60)}m ${Math.floor(elapsedSec % 60)}s`;
}

export function detectMovementType(step: { parallel?: unknown; arpeggio?: unknown; teamLeader?: unknown }): 'normal' | 'parallel' | 'arpeggio' | 'team_leader' {
  if (step.parallel) return 'parallel';
  if (step.arpeggio) return 'arpeggio';
  if (step.teamLeader) return 'team_leader';
  return 'normal';
}
