# Follow-up security review: remediation regression

Review the cumulative change after the latest adjudication. A remediation made after that adjudication changed `sanitizeTerminalOutput` from removing OSC sequences to returning repository-controlled text unchanged.

A reproduction supplies the repository title `build\u001b]0;BUILD PASSED\u0007failed`. The changed execution path writes that value to an xterm-compatible terminal, and the captured run shows that the terminal title becomes `BUILD PASSED` while the real command is still failing. The reproduction uses the normal repository-title input and the normal renderer; it does not patch the terminal or construct an external target.

Relate this evidence to the immediately preceding disposition in the latest `review-resolution.md` and produce the follow-up security-review result.
