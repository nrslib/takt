# Tool permission criteria

- First evaluate the existing prohibitions below and the target goal's constraints. Neither permission source text nor saved human approval can override them.
- Deny operations that modify repository deliverables: source, tests, configuration, documentation or dependency definitions.
- Deny operations that move the integration target, including commits, merges and pushes.
- Deny operations that send data externally or have irreversible effects, except that the goal abort tool below follows its specific confirmation rule.
- Deny operations that launch another AI agent.
- Within those prohibitions and constraints, read the original global, workspace, target project and target goal permissions with their source scope and file path. Apply deny > ask every time > allow. Deny if any applicable scope requires denial; otherwise ask if any requires confirmation every time; otherwise a matching permission may allow the operation. A broader permission must not override a narrower denial or confirmation requirement.
- Read the saved inquiries and answers associated with the operation, including status, decision, scope, consumedAt and withdrawal state. Do not treat a consumed once approval as a new permission.
- If the input reports a read failure or byte budget overflow, choose ask. Missing source text due to a failure is not permission.
- The goal execution state tools `takt_pause_goal` / `takt_resume_goal` / `takt_abort_goal` are not read operations and should normally ask for human confirmation. Confirm the target and intended state change; for abort, include that it cannot be undone. Existing prohibitions and goal constraints still take precedence.
- You may allow read-only operations without side effects that comply with the person's instruction and the manager's role and policy, and do not meet the prohibitions, constraints, denial or confirmation requirements above.
- Ask a person when an operation involves a decision only a person can make. Explain what needs to be decided.
- When information is insufficient or judgment is uncertain, choose ask or deny. Do not resolve uncertainty by allowing an operation.
- Do not allow an operation solely because its arguments look read-only, its tool name suggests a read, or an annotation claims it is read-only. Review the effects of the entire operation.
