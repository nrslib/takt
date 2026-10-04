import type { UserSummary } from '../../features/users/types.js';

export function UserAvatar({ user }: { user: UserSummary }) {
  return <img src={user.avatarUrl} alt={user.name} />;
}
