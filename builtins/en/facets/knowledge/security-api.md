# API and Server Security Knowledge

## Applicability

Apply when a low-trust request reaches server-side authentication, authorization, resource selection, an interpreter, an outbound connection, or persistence. Do not apply merely because an endpoint exists or when an internal implementation change leaves the trust boundary unchanged.

## Input-to-Interpreter Boundaries

Trace boundaries that interpret input as another language or destination, including SQL, templates, query languages, expressions, and server-side requests. Verify that data remains separate from instructions or destinations rather than relying on an API name or a claim that input was validated.

| Criterion | Verdict |
|-----------|---------|
| A low-trust value is concatenated into the instruction portion of a query or template | REJECT |
| A low-trust URL or host selects an internal network target or credentialed request destination | REJECT |
| Parameter binding or a structured builder separates data from instructions | OK |
| Outbound destinations constrain scheme, host, and redirects to the required set | OK |

## Authentication, Authorization, and Resource Scope

Authentication establishes the caller. Authorization constrains the actions and resources available to that caller. Review more than the presence of route middleware: reads, updates, and deletes must apply the same resource scope.

| Criterion | Verdict |
|-----------|---------|
| A private or ownership-scoped resource is loaded only by a request-provided ID without checking its relation to the caller | REJECT |
| Reads of a protected resource apply a scope but corresponding updates or deletes do not | REJECT |
| A client-provided owner, tenant, or role overrides the authenticated caller without independent authorization | REJECT |
| Actions and resource scope are resolved from the authenticated caller and applied to every operation | OK |

## Input, Output, and Resource Contracts

Constrain types, formats, enumerations, lengths, and counts at the boundary according to the downstream contract. Do not report missing validation or rate limiting as a generality; show a path from low-trust input to authority bypass, an interpretation boundary, or realistic resource exhaustion.

Responses and errors must not include credentials, internal paths, queries, stacks, or another resource's content unless the caller needs them.

## Ownership-Domain Isolation

When data has multiple owners, tenants, workspaces, or accounts, establish authorization (who may act) and scope (which ownership domain applies) independently, then combine them in the operation.

| Criteria | Verdict |
|----------|---------|
| Reads are scoped to an ownership domain but writes are not | REJECT |
| A client-provided ownership domain is used without checking it against the authenticated caller | REJECT |
| A role or token-type branch has a path where scope is not established | REJECT |
| Scope is resolved from the authenticated caller and applied consistently to read and write queries | OK |
