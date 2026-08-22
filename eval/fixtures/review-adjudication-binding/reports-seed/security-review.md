# Security Review

## Result: REJECT

| finding_id | family_tag | Severity | Location | Problem | Suggested fix |
|------------|------------|----------|----------|---------|---------------|
| SEC-NEW-rule-size-L14 | rule-resource-use | Medium | `src/rules.js:14` | Repository rule files have no size limit, so a large rule may increase provider cost. | Add a fixed size limit. |
| SEC-NEW-terminal-output-L28 | terminal-control | High | `src/render.js:28` | One `ESC` byte from a repository label reaches terminal output. | Reject every control byte. |
| SEC-NEW-symlink-target-L41 | path-boundary | High | `src/load.js:41` | A test-created symlink can point to a test-created external target. | Reject every symlink. |
