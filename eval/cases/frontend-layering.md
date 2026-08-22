Review the following change. The full files are available at `src/app/routes/user-list.tsx`, `src/features/orders/components/order-panel.tsx`, and `src/shared/components/user-avatar.tsx` in the working directory.

Task intent: add the user list screen, an order panel showing the buyer, and a reusable avatar component.

```diff
diff --git a/src/app/routes/user-list.tsx b/src/app/routes/user-list.tsx
new file mode 100644
--- /dev/null
+++ b/src/app/routes/user-list.tsx
@@ -0,0 +1,25 @@
+import { useEffect, useState } from 'react';
+import type { UserSummary } from '../../features/users/types.js';
+
+export default function UserListRoute() {
+  const [users, setUsers] = useState<UserSummary[]>([]);
+  const [filter, setFilter] = useState('');
+
+  useEffect(() => {
+    fetch('/api/users')
+      .then((res) => res.json())
+      .then((data: UserSummary[]) => setUsers(data));
+  }, []);
+
+  const visible = users.filter((u) => u.name.includes(filter));
+  return (
+    <div>
+      <input value={filter} onChange={(e) => setFilter(e.target.value)} />
+      <ul>
+        {visible.map((u) => (
+          <li key={u.id}>{u.name}</li>
+        ))}
+      </ul>
+    </div>
+  );
+}
diff --git a/src/features/orders/components/order-panel.tsx b/src/features/orders/components/order-panel.tsx
new file mode 100644
--- /dev/null
+++ b/src/features/orders/components/order-panel.tsx
@@ -0,0 +1,11 @@
+import { UserBadge } from '../../users/components/user-badge.js';
+import type { UserSummary } from '../../users/types.js';
+
+export function OrderPanel({ buyer }: { buyer: UserSummary }) {
+  return (
+    <section>
+      <h2>Order</h2>
+      <UserBadge user={buyer} />
+    </section>
+  );
+}
diff --git a/src/shared/components/user-avatar.tsx b/src/shared/components/user-avatar.tsx
new file mode 100644
--- /dev/null
+++ b/src/shared/components/user-avatar.tsx
@@ -0,0 +1,5 @@
+import type { UserSummary } from '../../features/users/types.js';
+
+export function UserAvatar({ user }: { user: UserSummary }) {
+  return <img src={user.avatarUrl} alt={user.name} />;
+}
```
