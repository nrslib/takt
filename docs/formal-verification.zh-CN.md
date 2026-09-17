# 形式规范验证（/verify）

[English](./formal-verification.md) | [日本語](./formal-verification.ja.md)

在交互模式下细化需求时，运行 `/verify` 可以把当前达成的共识写成形式规范，并用模型检查器进行验证。TAKT 会要求 Assistant 用 [Quint](https://quint-lang.org/) 和 [Alloy](https://alloytools.org/) 表达共识内容，从响应中提取 `quint` 和 `alloy` 代码块并运行验证器。结果会返回同一会话，由 Assistant 解释说明。

## 要求

运行 Quint 的 `parse`、`typecheck`、`run` 阶段不需要额外安装任何东西。Quint 作为 TAKT 的依赖随包提供，并在运行 TAKT 的同一 Node.js 上执行。

使用 `quint verify` 和 Alloy Analyzer 进行模型检查需要 Java 17 或更高版本。只要 `PATH` 上有 `java`，任何 JDK 发行版均可。若未找到 Java 或版本低于 17，模型检查阶段会被跳过并在结果中明确说明；Quint 的基础阶段仍会执行。

首次使用时会自动下载以下两项。

| 内容 | 时机 | 位置 |
|------|------|------|
| Apalache | 首次执行 `quint verify` 时由 Quint 下载 | `~/.quint/`（可用 `QUINT_HOME` 更改） |
| Alloy Analyzer 6.2.0 JAR | 首次进行 Alloy 验证时由 TAKT 下载并校验 SHA-256 | 项目内的 `.takt/cache/alloy/6.2.0/alloy.jar` |

用于时态属性的 TLC 包含在 Apalache 发行包中，无需单独安装。下载只发生一次且需要网络访问，之后的 `/verify` 可离线运行。

在无法访问网络的环境中使用 Alloy 时，请通过 `TAKT_ALLOY_JAR` 环境变量指定本地已有的 Alloy JAR。相对路径以项目目录为基准解析。

## 启用

`/verify` 仅在启用了形式规范模式的会话中可用。请在 `~/.takt/config.yaml` 或 `.takt/config.yaml` 中通过 `assistant.formal_spec` 配置。

```yaml
assistant:
  formal_spec:
    mode: 'Y/n'     # true、false、Y/n 或 y/N（默认：y/N）
    comments: true  # 为每个形式结构添加自然语言含义注释（默认：true）
    model_check_timeout_seconds: 300  # quint verify 与 Alloy 模型检查的上限秒数（默认：300）
```

`true` 和 `false` 不会询问，直接使用。`Y/n` 和 `y/N` 会在交互会话开始时询问一次，大写字母是直接按 Enter 时采用的默认回答。完整选项说明请参阅[配置](./configuration.zh-CN.md)。

## 验证流程

只有当 Assistant 的响应包含 Quint 或 Alloy 代码块时才会开始验证。两者都没有时，TAKT 只会报告这一点。

对于 Quint 代码块，TAKT 按顺序执行各阶段，某一阶段未通过时会跳过其后的所有阶段。

1. `parse` 检查语法。
2. `typecheck` 检查类型和效果。
3. `run` 模拟 1 个样本、最多 20 步。仅在找到包含 `init` 和 `step` action 的主模块，且选定的验证目标位于该模块中时执行。
4. 若有 Java 17 或更高版本，则以 20 步为上限执行 `quint verify`。包含时态属性的规范会切换到 TLC 后端，对整个状态空间进行穷举探索。

对于 Alloy 代码块，TAKT 独立于 Quint 结果运行 Alloy Analyzer。规范中的每个 `check` 命令都会被验证。

`parse`、`typecheck`、`run` 的超时为 60 秒。`quint verify` 和 Alloy Analyzer 的模型检查默认最多等待 5 分钟，可通过 `assistant.formal_spec.model_check_timeout_seconds` 调整。若状态数较多的规范导致 TLC 被中止，请增大该值或缩小模型。

## 验证目标的选择

只有符合命名约定的 Quint 定义才会成为验证目标。

| 类型 | 规则 | 示例 |
|------|------|------|
| 不变式 | 名称以 `inv` 开头的 `val` | `val invBalanceNonNegative = ...` |
| 时态属性 | 名称以 `prop` 开头的 `temporal` | `temporal propEventuallyDone = ...` |

请把它们放在含有 `init` 和 `step` action 的模块中。若目标位于主模块之外，`run` 会被跳过。Assistant 已通过形式规范模式的指引了解此约定，通常无需特别留意；手动补充规范时请遵循相同的命名。

在 Alloy 中，`check` 命令是验证目标，`run` 命令不会执行。

## 解读结果

结果汇总为 `passed`、`failed` 或 `error`，并附带各阶段的状态和消息。

- `passed` 表示已执行的所有阶段均成功。
- `failed` 表示不变式或时态属性被违反，或 Alloy 的 `check` 找到了反例。消息中包含反例的状态序列。
- `error` 表示验证无法完成：语法错误、类型错误、超时或验证器启动失败。因缺少 Java 而跳过模型检查也归入此类，消息中会写明被跳过的阶段及原因。

TLC 报告违反或失败时，TAKT 会从 `Error:` 行开始提取诊断信息并包含在结果中；无法识别的输出会原样包含。

## 故障排除

若 `quint verify` 和 Alloy 被跳过，请确认 `java -version` 返回 17 或更高版本。TAKT 直接调用 `PATH` 上的 `java`。

若 TLC 超时，请先增大 `model_check_timeout_seconds`。若仍无法完成，几乎可以肯定是状态空间无界。`--max-steps` 对 TLC 无效，请把所有状态变量（尤其是 `int` 变量）限制在有限范围内。

若 Alloy 的 `check` 以“Bounded engines do not support complete model checking”结束，说明命令的 scope 指定了 `1.. steps` 这类无限长 trace。TAKT 使用默认 SAT 求解器（SAT4J）运行 Alloy，只能进行有界检查；完整模型检查所需的 Electrod 和 nuXmv 不会被使用。请把 trace 长度改为有限值，例如 `for 3 but 8 steps`。

若 `quint verify` 以“Parsing or semantic analysis failed”停止，而 Quint 的 `parse` 和 `typecheck` 已通过，说明时态属性中使用了 TLC 不接受的写法。典型情况是在 `always` 中使用 `next(...)`，如 `always(x.subseteq(next(x)))`。请改写为不引用下一状态、仅使用状态变量的等价形式。

若 Alloy JAR 下载失败，请检查网络和代理设置，或通过 `TAKT_ALLOY_JAR` 提供本地 JAR。下载的 JAR 若 SHA-256 不匹配同样视为失败。

验证期间生成的临时文件位于 `.takt/runs/verify-*/`，验证结束时删除。若因异常退出而残留，下一次 `/verify` 会清理一小时以前的目录。
