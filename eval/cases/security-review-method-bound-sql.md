# Initial security review: parameter-bound SQL

Review only this supplied server change:

```typescript
app.get('/users', async (request, response) => {
  const name = String(request.query.name)
  const rows = await db.query('SELECT id, name FROM users WHERE name = ?', [name])
  response.json(rows)
})
```

`db.query` uses the database driver's documented parameter binding: the placeholder is parsed as data and `name` cannot alter SQL syntax. The route is intentionally public and returns only public directory fields. There is no separate sanitizer function and no other changed path.

Produce the initial security-review result based on the verified interpreter semantics.
