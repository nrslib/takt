# Common Security Knowledge

## Domain Knowledge Applicability

The Security reviewer evaluates only the security surfaces that exist in the changed system and its real execution paths. A filename, framework name, or installed dependency alone is not evidence that a domain applies.

| Knowledge | Applicable systems and changes |
|-----------|--------------------------------|
| `security-web` | Browsers, DOM, HTML generation, cookies, CORS, or browser-originated file submission |
| `security-api` | APIs or servers called by external or low-trust clients, authentication, authorization, database access, or tenant boundaries |
| `security-local` | CLIs, local agents, shell/process execution, filesystems, local configuration, plugins, or providers |
| `security-data` | Secrets, personal data, logs, cryptography, or error surfaces that handle protected data |
| `security-dependencies` | Package manifests, lockfiles, dependency resolution, distributed artifacts, or external components |

Multiple Knowledge domains can apply to one change. Do not use a domain's checklist as finding evidence when its applicability condition is not met. The assigned Policy's scope and blocking/warning boundary take precedence over examples in every Knowledge facet.

## AI-Generated Code Security Issues

AI-generated code commonly exhibits these vulnerability patterns.

| Pattern | Risk | Example |
|---------|------|---------|
| Plausible but unsafe defaults | High | Permissions broader than the actual contract requires |
| Outdated security practices | Medium | Deprecated cryptography or legacy authentication patterns |
| Incomplete validation | High | Validating syntax without validating boundary semantics |
| Excessive trust in input | Critical | Treating low-trust input as internal input |
| Copied vulnerability patterns | High | Repeating the same unsafe pattern across several locations |

Authentication, authorization, input boundaries, sensitive data, and configuration defaults need close inspection when they participate in a real trust boundary.

## Precedence Resolution, Override, and Trust Boundaries

Precedence across configuration or definition sources, intentional overrides, and extension points are not vulnerabilities by themselves. The relevant question is whether the change breaks a trust boundary or gives a lower-trust party a new capability.

| Criterion | Decision |
|-----------|----------|
| Resolution follows documented precedence within the same user and trust level | OK |
| An explicit selector or argument chooses the target under the existing precedence model | OK |
| A higher-priority definition wins within the customization contract without privilege or data-access expansion | Warning at most; normally not REJECT |
| A lower-trust source can override a higher-trust source and gain code execution, asset modification, data access, or authorization bypass | REJECT |
| Interactive confirmation is removed, but explicit selection remains unambiguous and the trust boundary is unchanged | OK |
| Confirmation was the only boundary control and its removal silently enables a lower-trust override | May be REJECT when the attack preconditions and impact are concrete |

### Decision Evidence

- Who is the lower-trust party, and which input or configuration can they control?
- What is the higher-trust asset?
- What becomes possible after the change that was not possible before?
- Why is that behavior outside the specified precedence or extension contract?

Allowing the same user at the same trust level to select an existing extension or definition normally does not create a new attack capability.
