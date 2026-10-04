import { useEffect, useState } from 'react';
import type { UserSummary } from '../../features/users/types.js';

export default function UserListRoute() {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetch('/api/users')
      .then((res) => res.json())
      .then((data: UserSummary[]) => setUsers(data));
  }, []);

  const visible = users.filter((u) => u.name.includes(filter));
  return (
    <div>
      <input value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul>
        {visible.map((u) => (
          <li key={u.id}>{u.name}</li>
        ))}
      </ul>
    </div>
  );
}
