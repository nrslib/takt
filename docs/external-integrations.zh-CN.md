# 外部集成

[English](./external-integrations.md) | [日本語](./external-integrations.ja.md) | [简体中文](./external-integrations.zh-CN.md)

本页收录社区构建的第三方集成。官方 GitHub/GitLab 集成请参阅[配置](./configuration.zh-CN.md)和 [CI/CD](./ci-cd.md)。

这些社区维护的示例可以在不修改 TAKT 核心的情况下扩展功能。它们不是 TAKT 官方支持的项目，列入此处也不表示背书；采用前请检查每个项目的许可证、依赖和安全状况。

如果要添加集成，请提交包含单行说明和公开仓库链接的 PR。

## 方法论工具包

在 TAKT 之上实现软件开发方法的 bundle：包含 workflow、facet 和可通过一条命令安装的辅助脚本。

| 集成 | 说明 |
|------|------|
| [j5ik2o/takt-sdd](https://github.com/j5ik2o/takt-sdd) | 面向 TAKT 的 Spec-Driven Development（SDD）方法论。提供 Requirements → Gap Analysis → Design → Tasks → Implementation → Validation workflow，以及 OpenSpec 风格的变更提案流程。它利用 TAKT 的阶段 gate、output contract 和审查循环，让定义清晰的 spec 忠实地转化为执行；阶段不能被静默跳过，偏差会回到 `fix`。与 provider 无关（Claude / Codex），使用 `npx create-takt-sdd` 安装。 |

## 审计轨迹 / Receipt 签名

| 集成 | 说明 |
|------|------|
| [ScopeBlind/examples/takt-workflow-receipts](https://github.com/ScopeBlind/examples/tree/main/takt-workflow-receipts) | 通过 step 的 `mcp_servers` 声明 MCP server，增加 Ed25519 签名 receipt 和 Cedar policy enforcement（必须先在 `workflow_mcp_servers` 配置策略中允许对应 transport）。Receipt 与 TAKT 的 NDJSON 日志并列保存，并可离线验证；不需要修改 TAKT 核心。 |
