# External Integrations

[English](./external-integrations.md) | [日本語](./external-integrations.ja.md) | [简体中文](./external-integrations.zh-CN.md)

This page is a catalog of community-built third-party integrations. For the official GitHub/GitLab integration, see [Configuration](./configuration.md) and [CI/CD](./ci-cd.md).

Community-maintained examples that extend TAKT without modifying its core. They are not officially supported by TAKT, and inclusion in this list is not an endorsement — please review each project's license, dependencies, and security posture before adopting it.

To add an integration here, open a PR with a one-line description and a link to a public repository.

## Methodology Kits

Bundles that implement a software development methodology on top of TAKT — pre-built workflows, facets, and helper scripts installable in one command.

| Integration | Description |
|-------------|-------------|
| [j5ik2o/takt-sdd](https://github.com/j5ik2o/takt-sdd) | An SDD kit with workflows and facets from requirements through implementation and validation. Supports Claude and Codex. Install with `npm install -g takt-sdd`. |

## Audit Trail / Receipt Signing

| Integration | Description |
|-------------|-------------|
| [ScopeBlind/examples/takt-workflow-receipts](https://github.com/ScopeBlind/examples/tree/main/takt-workflow-receipts) | Adds Ed25519-signed receipts and Cedar policy enforcement via an MCP server declared in a step's `mcp_servers` (the transport must first be allowed through the `workflow_mcp_servers` config policy). Receipts sit alongside TAKT's NDJSON logs and can be verified offline. No TAKT core changes required. |

## Runtime MCP vs legacy workflow `mcp_servers`

TAKT has two MCP configuration modes:

- **Legacy workflow mode**: MCP servers are declared per-step through `mcp_servers` and allowed through the `workflow_mcp_servers` config policy. This is what the community integrations above use.
- **Runtime MCP mode**: MCP servers are defined and assigned in the `mcp` section of `runtime.yaml` (`servers`, `defaults`, `targets`). Provider/model resolution stays on `config.yaml` when only the `mcp` section is active.

The two modes must not be mixed. When an active `mcp` section in `runtime.yaml` coexists with a workflow `mcp_servers` declaration or the `workflow_mcp_servers` policy, TAKT fails fast before any agent runs and reports the workflow/step and the migration target:

- workflow `mcp_servers` policy → `mcp.targets`
- step `mcp_servers` map → `mcp.targets.steps`

In runtime MCP mode, workflows cannot specify MCP server command, URL, header, or env — those belong to the `mcp` section in `runtime.yaml`. See [Configuration > Runtime MCP Configuration](./configuration.md#runtime-mcp-configuration-in-runtimeyaml) for the schema, effective server resolution, provider transport compatibility, and migration details.
