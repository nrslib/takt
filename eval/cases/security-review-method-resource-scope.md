# Initial security review: update without ownership scope

Review only this supplied server change:

```typescript
app.patch('/documents/:id', requireUser, async (request, response) => {
  const document = await documents.updateById(request.params.id, request.body.title)
  response.json(document)
})
```

`requireUser` authenticates any ordinary account but does not authorize a document. `updateById` updates solely by the caller-provided document ID and applies no owner or tenant scope. Document IDs are visible in shared links. Before this change, updates used both the authenticated account ID and document ID. An ordinary authenticated user can therefore select and modify another account's private document.

Produce the initial security-review result and identify the caller, broken scope boundary, reachable update, and integrity impact.
