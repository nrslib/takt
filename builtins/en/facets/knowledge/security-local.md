# CLI and Local Execution Security Knowledge

## Applicability

Apply to changes that involve a CLI, shell or process execution, filesystem access, or local configuration.

## Injection Attacks

**Command Injection:**

- Unvalidated input in `exec()`, `spawn()` → REJECT
- Insufficient escaping in shell command construction → REJECT

```typescript
// NG
exec(`ls ${userInput}`)

// OK
execFile('ls', [sanitizedInput])
```

## File Operations

**Path Traversal:**

- File paths containing user input → REJECT
- Insufficient `../` sanitization → REJECT

```typescript
// NG
const filePath = path.join(baseDir, userInput)
fs.readFile(filePath)

// OK
const safePath = path.resolve(baseDir, userInput)
if (!safePath.startsWith(path.resolve(baseDir))) {
  throw new Error('Invalid path')
}
```

## OWASP Top 10 Checklist

| Category | Check Items |
|----------|-------------|
| A03 Injection | Command |
