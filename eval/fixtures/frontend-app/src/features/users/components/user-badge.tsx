import type { UserSummary } from '../types.js';

export function UserBadge({ user }: { user: UserSummary }) {
  return <span className="user-badge">{user.name}</span>;
}
