export class TeamLeaderPartCancellation extends Error {
  constructor(readonly partId: string) {
    super(`Team leader part cancelled: ${partId}`);
    this.name = 'TeamLeaderPartCancellation';
  }
}

export function createTeamLeaderPartCancellation(partId: string): TeamLeaderPartCancellation {
  return new TeamLeaderPartCancellation(partId);
}

export function isTeamLeaderPartCancellation(error: unknown): error is TeamLeaderPartCancellation {
  return error instanceof TeamLeaderPartCancellation;
}
