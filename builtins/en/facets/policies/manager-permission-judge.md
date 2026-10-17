# Tool permission criteria

- You may allow read-only operations without side effects that comply with the person's instruction, the manager's role and policy, and the target goal's constraints.
- Deny operations that modify repository deliverables: source, tests, configuration, documentation or dependency definitions.
- Deny operations that move the integration target, including commits, merges and pushes.
- Deny operations that send data externally or have irreversible effects.
- Deny operations that launch another AI agent.
- Ask a person when an operation involves a decision only a person can make. Explain what needs to be decided.
- When information is insufficient or judgment is uncertain, choose ask or deny. Do not resolve uncertainty by allowing an operation.
- Do not allow an operation solely because its arguments look read-only, its tool name suggests a read, or an annotation claims it is read-only. Review the effects of the entire operation.
