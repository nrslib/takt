# Security Knowledge

## Threat-Model Evidence

A security boundary is a change in who can control a value, who can observe it, or which authority interprets or acts on it. Use these relationships as decision material rather than treating a security practice or API name as a finding.

| Condition | Boundary and impact to establish |
|-----------|----------------------------------|
| A value moves between actors with different trust or authority | Identify the controlling actor, receiving authority, and capability gained after the transfer |
| A value is interpreted as code, a command, a query, a path, a URL, or another instruction | Identify the interpreter, the part controlled as instructions, and the authority under which it runs |
| An output contains protected data | Identify the data, every actor who can observe the output, and which observer is unauthorized |
| A change alters authentication, authorization, scope, sandbox, or credentials | Compare the action and protected asset available before and after the change |
| A control is absent or removed | Determine whether it was the control that enforced an actual boundary, rather than assuming its absence creates impact |

## Precedence Resolution, Override, and Trust Boundaries

Multiple configuration or definition sources, documented precedence, intentional overrides, and extension points are not vulnerabilities by themselves. The relevant evidence is whether a lower-trust actor gains a capability outside the documented model.

| Condition | Suggested boundary or impact |
|-----------|------------------------------|
| Resolution follows documented precedence within the same actor and trust level | No new actor or authority boundary is implied |
| An explicit selector chooses among definitions allowed by the same customization contract | Selection alone does not imply expanded privileges or data access |
| A higher-precedence source wins within its documented scope | Compare trust levels and capabilities; precedence alone does not establish impact |
| A lower-trust source can override a higher-trust setting | Trace whether the override enables code execution, higher-trust asset modification, data access, or authorization bypass |
| A confirmation step is removed | Determine whether explicit selection already establishes intent or whether confirmation was the only control separating trust levels |

For precedence or override concerns, identify the lower-trust actor and controlled source, the protected asset, what becomes possible only after the change, and how that exceeds the documented contract.
