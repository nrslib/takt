Review the changes from a security perspective. Check for the following vulnerabilities:
- Injection attacks (SQL, command, XSS)
- Authentication and authorization flaws
- Data exposure risks
- Cryptographic weaknesses

**Primary sources to review:**
- Review `order.md` to understand requirements and prohibitions.
- Review `plan.md` to understand intended scope and design direction.
- Review {report:coder-decisions.md} to understand the recorded design decisions.
- Do not dismiss documented decisions as FP by default. Re-evaluate them against `order.md`, `plan.md`, and the actual code.

**Important:**
- Do not treat documented precedence rules, extension points, or configuration override behavior as vulnerabilities by themselves.
- Do not assume that removing an interactive confirmation or warning automatically means a security boundary regression.
- To issue a blocking finding, make the exploit path concrete: who controls what input, and what newly becomes possible.

## Judgment Procedure

1. Cross-check `order.md`, `plan.md`, `coder-decisions.md`, and the actual code to determine whether the behavior is intentional product behavior
2. Review the change diff and extract issue candidates by cross-checking changes against REJECT criteria in knowledge
3. For each candidate, verify the concrete exploit path
   - Which actor controls the input or configuration
   - Whether the change enables new privilege, data access, code execution, or prompt modification
   - Whether the impact exceeds the existing documented precedence or extension model
4. When configuration precedence, local/global shadowing, or non-interactive selection is involved, additionally verify:
   - Whether the behavior is intended by `order.md` or `plan.md`
   - Whether explicit selectors or arguments already make the user's intent clear
   - Whether there is an actual trust-boundary break or new attack capability, rather than merely an override relationship
5. For each detected issue, classify it as blocking or non-blocking based on the Policy scope table and judgment rules
6. If there is even one blocking issue, judge as REJECT
