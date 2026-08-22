import { UserBadge } from '../../users/components/user-badge.js';
import type { UserSummary } from '../../users/types.js';

export function OrderPanel({ buyer }: { buyer: UserSummary }) {
  return (
    <section>
      <h2>Order</h2>
      <UserBadge user={buyer} />
    </section>
  );
}
