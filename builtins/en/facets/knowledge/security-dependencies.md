# Dependency Security Knowledge

## Applicability

Apply when a change adds, removes, resolves, configures, or updates a dependency or its lockfile entry.

## Vulnerability Reachability

A CVE, advisory, or unmaintained status alone does not establish that the change introduces an exploitable path. Establish all relevant links:

- The exact resolved version changed by the diff
- The affected version range in a primary advisory or vendor source
- The vulnerable package function or runtime feature reached by this project
- The low-trust input, actor access, deployment mode, platform, or configuration required by the vulnerability
- The authority and protected asset available when the reachable function executes
- Whether the change introduces the affected version or leaves the relevant path unchanged

When one of these links is absent, record what is unverified rather than inferring exploitability from the package name. When the resolved version, affected range, reachable feature, attack preconditions, and concrete impact are all established, static dependency and call-path evidence can establish the security path without reproducing real-world harm.

## Integrity and Resolution

For registries, lockfiles, checksums, install scripts, build plugins, and source references, identify who controls the resolved artifact, which verification protects it, when its code executes, and under which build or runtime authority. A new dependency's necessity or maintenance quality is not itself a security boundary unless it creates a verified integrity or execution path.
