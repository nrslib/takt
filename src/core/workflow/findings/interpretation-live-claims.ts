export interface InterpretationLiveClaimRegistry {
  isClaimed(ledgerIdentity: string, reservationToken: string): boolean;
  acquire(ledgerIdentity: string, reservationToken: string): void;
  release(ledgerIdentity: string, reservationToken: string): void;
}

function claimKey(ledgerIdentity: string, reservationToken: string): string {
  return `${ledgerIdentity}\0${reservationToken}`;
}

class ProcessInterpretationLiveClaimRegistry implements InterpretationLiveClaimRegistry {
  private readonly claims = new Set<string>();

  isClaimed(ledgerIdentity: string, reservationToken: string): boolean {
    return this.claims.has(claimKey(ledgerIdentity, reservationToken));
  }

  acquire(ledgerIdentity: string, reservationToken: string): void {
    const key = claimKey(ledgerIdentity, reservationToken);
    if (this.claims.has(key)) {
      throw new Error(`Interpretation reservation "${reservationToken}" is already live`);
    }
    this.claims.add(key);
  }

  release(ledgerIdentity: string, reservationToken: string): void {
    this.claims.delete(claimKey(ledgerIdentity, reservationToken));
  }
}

export const processInterpretationLiveClaims: InterpretationLiveClaimRegistry =
  new ProcessInterpretationLiveClaimRegistry();
