# CLI and Local Execution Security Knowledge

## Applicability

Apply this Knowledge when a change affects a CLI, local agent, shell/process execution, filesystem, project or user configuration, plugin, provider, or local IPC. Do not apply it to remote APIs or browser-only boundaries.

## Local Trust Boundaries

When project configuration, user configuration, caches, and run history owned by the same OS user are intentionally within one trust level, modification by that same user alone is not a vulnerability. Treat another user, a low-trust repository, downloaded artifacts, and external provider output as separate boundaries when they cross into higher-trust operations.

| Situation | Decision |
|-----------|----------|
| Documented project/user configuration precedence | Normally OK |
| An explicit selector chooses a definition at the same trust level | Normally OK |
| A low-trust repository can modify user-global commands or credentials | REJECT candidate when a concrete path exists |
| Provider output reaches a shell, path, or configuration without validation | Establish reachability and impact |

## Command Injection

- A reachable path concatenates low-trust input into a shell command string → REJECT
- An argument array bypasses the shell and the input cannot change command or option boundaries → OK

```typescript
// NG
exec(`tool ${userInput}`)

// OK
execFile('tool', [validatedInput])
```

Using a shell API alone is not grounds for REJECT. Identify which command, argument, environment variable, or working directory an attacker controls.

## File Operations and Path Traversal

- A low-trust path can resolve outside its allowed root → REJECT
- A reachable path fails to validate the resolved result for `..`, absolute paths, or symlinks → REJECT
- The presence of input in a path alone is not grounds for REJECT; inspect the allowed root and resolved-path validation

```typescript
const safePath = path.resolve(baseDir, userInput)
if (!safePath.startsWith(`${path.resolve(baseDir)}${path.sep}`)) {
  throw new Error('Invalid path')
}
```

## Plugins, Providers, and External Tools

Assign trust according to each plugin, provider, or tool's source and execution privileges. Do not rely only on a hypothetical malicious provider or modified plugin; establish how its output crosses an existing boundary and enables a new operation.
