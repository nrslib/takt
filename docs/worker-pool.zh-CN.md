# worker pool 与云端部署

[English](./worker-pool.md) | [日本語](./worker-pool.ja.md) | [简体中文](./worker-pool.zh-CN.md)

worker pool 将 daemon 自动执行的 manager 目标任务分配给 daemon 所在机器的内置 worker 和其他机器上的远程 worker。manager 对话和任务分配由 daemon 管理，worker 有空闲容量时向 daemon 请求任务。多个仓库共享同一个 pool，同时受 worker 上限和各项目的 `concurrency` 上限约束。

单机使用流程保持不变。未注册远程 worker 时，由内置 worker 执行任务。`takt run`、`takt watch` 和交互模式仍使用原有的本地执行路径，这些配置不会把它们的任务发送到远程 worker。

## 代码与执行资源的传递

daemon 确定任务的原始 SHA 并将其 push 到 origin。worker 从 origin 获取该 SHA 的代码，从 daemon 接收任务指示、附件、workflow、facet 和解析后的配置。无需在各 worker 上手动放置仓库专用的 TAKT 配置或 workflow。

worker 将成果 push 到 origin，并把 run 日志和报告发送给 daemon。daemon 接收记录、fetch 成果并核对 SHA 后才保存完成状态。连接成功本身不代表任务成功。

## 准备 daemon 机器

在云实例中准备 Node.js 22.22.0 或更高版本、准备使用的 TAKT 版本、Git，以及 manager 和内置 worker 所需的 provider 与项目工具。为执行用户配置 Git 提交姓名和邮箱。使用 `takt install codex` 等命令提前安装 SDK；可用目标见 [CLI 参考](./cli-reference.zh-CN.md#托管sdk的安装与更新)。

以 daemon 执行用户放置仓库并配置 origin。daemon 需要 push 原始分支和 fetch 成果的权限，worker 需要获取代码和 push 成果分支的权限。本指南使用可通过 Git 令牌认证的 HTTPS origin，不要把令牌嵌入 origin URL。使用 PR 操作时，还需准备 `gh` 和相应的操作权限。

以同一用户在各仓库中打开一次 `takt manager`，将其注册为 manager 负责的项目。自动执行目标任务需要 `manager.auto_run: true` 和可执行的 pending 目标任务。创建与操作目标的方法见[目标管理指南（英文）](./goal-management.md)。通过实例上的终端或已配置的 Slack 与云端 manager 对话。不能通过 worker 通信端点连接远程 TUI 或 Web UI。

在 daemon 的全局配置 `~/.takt/config.yaml` 中添加以下内容。使用 `TAKT_CONFIG_DIR` 时，应编辑该目录下的 `config.yaml`。

```yaml
daemon:
  builtin_worker:
    concurrency: 1
  remote_worker:
    host: 127.0.0.1
    port: 54322
    credentials:
      git: ${WORKER_GIT_TOKEN}
      gh: ${WORKER_GH_TOKEN}
      providers:
        openai: ${WORKER_OPENAI_KEY}
```

通过云端秘密管理等设施，将引用的秘密值注入 daemon 服务的环境。这些名称只是示例，并不是 TAKT 自动读取的环境变量名。删除不需要分发的认证项。引用的变量为空或未设置时，认证分发会失败。daemon 自身执行 Git、gh 和 manager 所需的认证也要在其执行环境中单独准备；`credentials` 用于向远程任务分发认证。

将内置上限保留为1，可执行 PR 合并任务。设为0后，内置 worker 不执行普通任务和合并任务，因此合并任务无法推进。省略上限时的区别、支持的 provider 键和认证优先级见 [daemon 配置](./configuration.zh-CN.md#daemon-worker-pool)。

## HTTPS 与常驻启动

示例监听地址接收同一实例上反向代理转发的 HTTP 请求。对外提供 `https://daemon.example.test` 等 URL，在反向代理等前置服务终止 TLS。TAKT 自身不终止 TLS。即使使用 VPN，worker URL 也必须使用 HTTPS，明文 HTTP 仅允许 localhost。

前置服务必须持续双向转发 `POST /worker` 的请求和响应。应支持长连接的 HTTP/1.1 NDJSON 通信，避免收齐整个请求或响应后才转发，并设置允许长时间连接的超时。转发 Authorization 头，但不要在访问日志中记录其值。54322端口的内部监听只允许必要的前置服务访问。worker 主动向外连接，无需开放 worker 的入站监听端口。

在服务管理工具中设置 daemon 执行用户、稳定的 HOME 和配置目录、认证信息及 PATH。让服务在操作系统启动时运行以下前台命令，并在异常退出后重新启动：

```sh
takt daemon --resident
```

如果 daemon 已在运行，先通过 `takt daemon stop` 停止，再启动。修改配置后也按相同步骤重启。`--resident` 只禁止自动退出，不会注册操作系统启动服务。停止、版本不一致和普通启动的退出条件见 [CLI 参考](./cli-reference.zh-CN.md#daemon-的常驻启动与自动退出)。

## 注册 worker 与无人值守启动

以 daemon 的用户、使用相同配置目录执行注册：

```sh
takt worker add cloud-1 --concurrency 2
takt worker list
```

注册时，连接令牌只向标准输出显示一次，无法通过 `list` 再次取得。增加 worker 时，以不同名称分别注册，并提供各自的令牌。同一注册建立新连接时，之前的连接会被关闭。`list` 显示注册名称和 concurrency，不显示连接状态。详细命令见 [worker CLI](./cli-reference.zh-CN.md#worker)。

worker 镜像应包含与 daemon 相同版本的 TAKT、Node.js、Git、Git 提交姓名和邮箱、所用 provider 的 SDK 或 CLI，以及项目的构建和测试工具。PR 操作或 workflow 需要时，还应安装 `gh`。使用 `takt install <provider>` 安装 SDK，并单独准备外部 OpenCode CLI 等工具。daemon 配置指定的可执行路径也必须在 worker 上可用。工具二进制文件不会自动传输。

将以下脚本配置为云端启动脚本或服务。启动时传入的 worker 专用连接配置只有 URL 和注册令牌。

```sh
#!/bin/sh
set -eu
: "${WORKER_DAEMON_URL:?Set the daemon HTTPS URL}"
: "${TAKT_WORKER_TOKEN:?Inject the worker registration token}"
export TAKT_WORKER_TOKEN
exec takt worker --url "$WORKER_DAEMON_URL"
```

例如将 URL 设为 `https://daemon.example.test`，通过秘密管理注入注册时取得的令牌。如需在文档或模板中显示值，请使用 `EXAMPLE_NOT_A_VALID_TOKEN` 等明显的假值。不要把真实值保存到镜像、Git 或启动日志，也不要启用 shell 命令跟踪。也可以用 `--token-file <path>` 从文件读取令牌；文件权限必须不允许组和其他用户访问（600；此权限检查在 Windows 上不生效，请自行收紧文件的 ACL）。用 `--token <token>` 传递仍然可用，但令牌会出现在进程参数中，同机用户可用 ps 读取，启动时会打印警告。令牌只能用其中一种方式传递；同时用两种以上方式会停止启动。通过镜像和启动配置完成准备后，无需在启动后登录 worker 服务器。

## 验证与运行限制

在 worker 启动输出中确认 `Worker cloud-1 connected`。随后在 daemon 机器的 manager 中提交目标任务，检查任务列表中的 worker 名称、执行结果，以及汇集到 daemon 的 run 日志和报告。任务也可能由 `builtin` 执行。如果为了单独验证远程执行而临时将内置上限设为0，验证后应恢复并重启 daemon。在此期间，PR 合并任务和没有 origin 的任务无法推进。

断开连接的执行可在60秒 lease 期限内在同一 worker 上继续。过期任务被记录为失败，已接收的记录保留。失败任务会在原 worker 上预留一个槽位。requeue/retry 时，如果原 worker 的工作目录仍在，可以恢复执行。注册被删除或重试时持续断连60秒，则使用其他 worker 的空闲容量，从保存的原始 SHA 重新开始。工作目录丢失时，也会在新目录中从原始 SHA 开始。不会把执行中途的状态转移到其他 worker。

在 daemon 机器上运行以下命令可删除注册。正在连接的 worker 会被断开，此后不再接受该分配的成果。

```sh
takt worker remove cloud-1
```

删除注册会使连接令牌失效，但不会撤销已经分发的 Git 令牌。必要时还需在 GitHub 上撤销。gh 和 provider 的认证也应在其签发方管理。分发的认证会传给任务子进程，因此只应注册可信的 worker 机器。注册和认证分发不提供按仓库隔离权限的能力。

PR 合并任务和没有 origin 的任务仅由内置 worker 执行。不支持按标签或 provider 分配任务，不通过云 API 或 SSH 创建、启动、删除机器，也不通过 manager 对话注册、删除 worker 或签发令牌。执行环境的准备和启动由用户的云端配置负责。
