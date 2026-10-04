Review the following change. The full file is available at `src/user-store.ts` in the working directory.

Task intent: add a `UserStore` class that registers users, bulk-loads them from a JSON string, supports profile updates, and provides name-sorted listings.

```diff
diff --git a/src/user-store.ts b/src/user-store.ts
new file mode 100644
--- /dev/null
+++ b/src/user-store.ts
@@ -0,0 +1,43 @@
+export interface User {
+  id: string;
+  name: string;
+  email?: string;
+}
+
+export class UserStore {
+  private readonly users = new Map<string, User>();
+
+  register(user: User | undefined): string {
+    const userId = user?.id ?? 'unknown';
+    this.users.set(userId, user as User);
+    return userId;
+  }
+
+  loadFromJson(json: string): User[] {
+    try {
+      const parsed = JSON.parse(json) as User[];
+      for (const user of parsed) {
+        this.users.set(user.id, user);
+      }
+      return parsed;
+    } catch {
+      return [];
+    }
+  }
+
+  // TODO: validate the patch fields
+  updateProfile(id: string, patch: any): void {
+    const current = this.users.get(id);
+    if (current) {
+      this.users.set(id, { ...current, ...patch });
+    }
+  }
+
+  sortByName(users: User[]): User[] {
+    return users.sort((a, b) => a.name.localeCompare(b.name));
+  }
+
+  find(id: string): User | undefined {
+    return this.users.get(id);
+  }
+}
```
