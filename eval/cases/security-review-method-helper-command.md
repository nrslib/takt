# Initial security review: HTTP input reaches a command through a helper

Review only this supplied cumulative change. The route itself is unchanged:

```typescript
app.get('/probe', async (request, response) => {
  response.send(await runProbe(String(request.query.target)))
})
```

The changed helper is:

```typescript
export async function runProbe(target: string): Promise<string> {
  return execAsync(`curl --silent ${target}`)
}
```

`execAsync` invokes `/bin/sh -c` under the server process account. The HTTP caller controls `target`, and the normal route calls this helper without validation or transformation. Shell metacharacters therefore reach the command interpreter and can execute commands with the server account's filesystem and network authority. No attack PoC was run.

Produce the initial security-review result. Do not stop at the helper diff line; identify the caller-to-interpreter path and impact.
