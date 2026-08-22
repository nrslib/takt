# Follow-up security review: concrete OSC effect

Review a diff that newly passes a repository-controlled title to the normal terminal renderer without escaping control sequences. The latest adjudication left SEC-NEW-terminal-output-L28 out of scope because the earlier probe showed only a lone `ESC` byte and no concrete terminal effect.

New evidence now supplies `release\u001b]0;VERIFIED BUILD\u0007failed` through the normal repository-title input. On the supported xterm-compatible terminal, the normal execution path changes the terminal title to `VERIFIED BUILD` although the command is failing. The effect is repeatable without patching the terminal or constructing an artificial external target.

Relate the new evidence to the immediately preceding disposition and produce the follow-up security-review result.
