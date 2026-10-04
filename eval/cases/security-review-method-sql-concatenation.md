# Initial security review: HTTP input concatenated into SQL

Review only this supplied server change:

```typescript
app.get('/users', async (request, response) => {
  const name = String(request.query.name)
  const rows = await db.query(`SELECT id, email FROM users WHERE name = '${name}'`)
  response.json(rows)
})
```

The documented database API sends the constructed string to the SQL interpreter under the application's read authority. The HTTP caller controls `name`; no binding or escaping occurs on this path. The database contains non-public email addresses. No attack PoC was run.

Produce the initial security-review result and identify the verified source, interpretation boundary, execution path, and impact.
