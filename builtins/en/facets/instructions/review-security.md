Focus on reviewing **security**.

Procedure:
1. Open the Knowledge and Policy Source paths with the Read tool and obtain the full content
2. List every `##` section in each of them (do not cherry-pick)
3. Match the criteria in each listed section against the diff and detect any issues

## Step-Specific Notes

- Do not treat documented precedence rules, extension points, or configuration override behavior as vulnerabilities by themselves
- Do not assume that removing an interactive confirmation or warning automatically means a security boundary regression
- To issue a blocking finding, make the exploit path concrete: which actor controls what input, and what newly becomes possible
- When configuration precedence, local/global shadowing, or non-interactive selection is involved, additionally verify:
  - Whether the behavior is intended by `order.md` or `plan.md`
  - Whether explicit selectors or arguments already make the user's intent clear
  - Whether there is an actual trust-boundary break or new attack capability, rather than merely an override relationship
