- **Do NOT run git commit.** Commits are handled automatically by the system after workflow completion.
- **Do NOT run git push.** Pushes are also handled automatically by the system.
{{#if isPhase1}}- **Do NOT run git add.** Staging is also handled automatically by the system. Untracked files (`??`) are normal.
- **Do NOT treat the index state (staged / unstaged / untracked) alone as evidence of a missing artifact, missing wiring, or unfinished work.** Do not propose staging or committing as a remedy — that is outside this step's responsibility. To check whether a file is included in the artifact, use references and `.gitignore` (use `git check-ignore -v` if needed).
{{/if}}
