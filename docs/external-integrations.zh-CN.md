# 外部集成

[English](./external-integrations.md) | [日本語](./external-integrations.ja.md) | [简体中文](./external-integrations.zh-CN.md)

本页收录社区构建的第三方集成。官方 GitHub/GitLab 集成请参阅[配置](./configuration.zh-CN.md)和 [CI/CD](./ci-cd.md)。

这些社区维护的示例可以在不修改 TAKT 核心的情况下扩展功能。它们不是 TAKT 官方支持的项目，列入此处也不表示背书；采用前请检查每个项目的许可证、依赖和安全状况。

如果要添加集成，请提交包含单行说明和公开仓库链接的 PR。

## 方法论工具包

在 TAKT 之上实现软件开发方法的 bundle：包含 workflow、facet 和可通过一条命令安装的辅助脚本。

| 集成 | 说明 |
|------|------|
| [j5ik2o/takt-sdd](https://github.com/j5ik2o/takt-sdd) | 提供从需求到实现与验证的 SDD workflow 和 facet。支持 Claude 和 Codex。使用 `npm install -g takt-sdd` 安装。 |

## 审计轨迹 / Receipt 签名

| 集成 | 说明 |
|------|------|
| [ScopeBlind/examples/takt-workflow-receipts](https://github.com/ScopeBlind/examples/tree/main/takt-workflow-receipts) | 通过 step 的 `mcp_servers` 声明 MCP server，增加 Ed25519 签名 receipt 和 Cedar policy enforcement（必须先在 `workflow_mcp_servers` 配置策略中允许对应 transport）。Receipt 与 TAKT 的 NDJSON 日志并列保存，并可离线验证；不需要修改 TAKT 核心。 |

## Runtime MCP 与旧版 workflow `mcp_servers`

TAKT 支持两种 MCP 配置模式。

- **旧版 workflow 模式**：每个 step 通过 `mcp_servers` 声明 MCP server，并由 `workflow_mcp_servers` 配置策略授权。上面的社区集成使用这种方式。
- **runtime MCP 模式**：在 `runtime.yaml` 的 `mcp` 部分（`servers`、`defaults`、`targets`）定义并分配 MCP server。仅启用 `mcp` 部分时，provider/model 仍由 `config.yaml` 解析。

两种模式不能混用。如果 `runtime.yaml` 中有效的 `mcp` 部分与 workflow 的 `mcp_servers` 声明或 `workflow_mcp_servers` 策略同时存在，TAKT 会在 agent 执行前立即停止，并报告对应的 workflow/step 和迁移位置。

- config 中的 `workflow_mcp_servers` 是 transport 许可策略，不能将其值直接复制到 runtime 分配中。迁移时应移除旧策略。
- 将 step 的 `mcp_servers` 中的 server 定义移到 `mcp.servers`，再通过 `mcp.targets.steps` 手动分配 server 名称。

在 runtime MCP 模式下，workflow 不能指定 MCP server 的 command、URL、header 或 env。这些值在 `runtime.yaml` 的 `mcp` 部分定义。配置结构、实际 server 解析、各 provider 支持的 transport 和迁移说明，参见[英文配置指南中的 Runtime MCP 配置](./configuration.md#runtime-mcp-configuration-in-runtimeyaml)。
