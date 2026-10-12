export function createTimestampedTaktBranchName(slug: string | undefined): string {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 13);
  return slug ? `takt/${timestamp}-${slug}` : `takt/${timestamp}`;
}
