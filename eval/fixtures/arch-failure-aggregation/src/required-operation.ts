export interface Profile {
  id: string;
  displayName: string;
}

export type StoreProfile = (profile: Profile) => Promise<Profile>;

export async function publishProfile(
  profile: Profile,
  storeProfile: StoreProfile,
): Promise<Profile> {
  const stored = await storeProfile(profile);
  return stored;
}
