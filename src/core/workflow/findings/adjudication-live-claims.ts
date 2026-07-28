export interface AdjudicationLiveClaimRegistry {
  claim(ledgerIdentity: string, reservationToken: string): boolean;
  release(ledgerIdentity: string, reservationToken: string): void;
}

function claimKey(ledgerIdentity: string, reservationToken: string): string {
  return `${ledgerIdentity}\0${reservationToken}`;
}

class ProcessAdjudicationLiveClaimRegistry implements AdjudicationLiveClaimRegistry {
  private readonly claims = new Set<string>();

  claim(ledgerIdentity: string, reservationToken: string): boolean {
    const key = claimKey(ledgerIdentity, reservationToken);
    if (this.claims.has(key)) {
      return false;
    }
    this.claims.add(key);
    return true;
  }

  release(ledgerIdentity: string, reservationToken: string): void {
    this.claims.delete(claimKey(ledgerIdentity, reservationToken));
  }
}

export const processAdjudicationLiveClaims: AdjudicationLiveClaimRegistry =
  new ProcessAdjudicationLiveClaimRegistry();
