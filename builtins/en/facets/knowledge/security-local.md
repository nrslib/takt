# Local Process and Filesystem Boundary Security Knowledge

## Applicability

Apply when low-trust CLI input, configuration, environment variables, or repository files reach process execution, filesystem operations, or local authority. Do not apply when only fixed internal inputs are involved and no trust boundary changes.

## Process Execution

Trace the executable, arguments, environment, and working directory as separate boundaries. Do not decide from an API name such as `spawn` or `exec`; determine whether a low-trust value is reinterpreted as shell syntax or an execution target.

| Criterion | Verdict |
|-----------|---------|
| A low-trust value is concatenated into a shell command string | REJECT |
| A low-trust value selects an executable, loader, plugin, or code search path beyond the declared trust or authority boundary | REJECT |
| A fixed executable receives an argument array without shell reinterpretation | OK, but verify that the argument itself cannot select a dangerous feature |
| The executable, arguments, environment, and working directory are constrained separately by contract | OK |

```typescript
// NG: the shell reinterprets the input as syntax
exec(`tool --input ${userInput}`)

// OK: fix the executable and pass a validated value as one argument
spawn('tool', ['--input', validatedPath], { shell: false })
```

## Filesystem Containment

A check for `../` or a matching string prefix does not prove containment. Check the normalized relative relationship, and check canonical paths at boundaries where existing symlinks must not escape the root.

| Criterion | Verdict |
|-----------|---------|
| A low-trust path reaches a read, write, or delete outside the allowed root | REJECT |
| Containment relies only on a matching string prefix | REJECT |
| A normalized path is checked not to escape relative to the root | OK |
| Existing paths involving symlinks are checked canonically when the boundary requires it | OK |

```typescript
// Lexical containment only; compare real paths for existing paths when symlink escape is forbidden
const root = path.resolve(baseDir)
const target = path.resolve(root, userInput)
const relative = path.relative(root, target)
if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  throw new Error('Invalid path')
}
```

## Local Configuration and Credentials

Configuration read from a repository or working directory may not share the trust level of user-global configuration or runtime credentials. Verify that low-trust configuration cannot widen sandbox, tool, network, or output boundaries. Do not leave credentials or sensitive values in command arguments, logs, errors, or generated artifacts.
