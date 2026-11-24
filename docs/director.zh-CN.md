# director 使用指南（实验性）

[English](./director.md) | [日本語](./director.ja.md) | [简体中文](./director.zh-CN.md)

director 将请求交给负责的 manager，检查目标进展，并回答约定范围内的问题。manager 推进其负责仓库中的工作。每个请求只交给一个 manager。

## 开始对话

在交互终端中运行：

```bash
takt director
```

需要时会启动 daemon，由 daemon 持有对话。关闭并重新打开 TUI 后会继续同一个对话，从另一个负责的仓库启动也一样。之前的发言和回复不会重新显示。

director 是实验性功能，行为、配置和保存的数据格式可能随时更改，恕不另行通知。人工对话和事件处理都会产生 provider 费用。

## 选择负责的 manager

可以直接说“给博客添加文章列表页”。director 根据 `takt_list_managers` 的列表和请求内容选择 manager，无需先由人指定 manager ID。如果有多个候选等原因导致无法确定，会列出候选和需要确认的事项，不会创建目标。

如果仓库还没有 manager，请提供 Git 仓库的绝对路径，例如“在 /work/new-app 中做这项工作”。director 使用 `takt_add_manager` 准备 manager，返回其 ID；即使没有目标，该 manager 也会出现在列表中。相对路径、不存在的位置和非 Git 仓库目录会被拒绝。director 不会搜索其他仓库代替它。

`takt_add_manager` 等名称是 director 使用的工具。用户通过对话提出请求即可。

## 确认一次即可注册

确定负责的 manager 后，director 会提出包含 manager、仓库、目的、范围外事项、验收条件和约束的注册方案。请检查内容，如需更改，在对话中说明并确认修改后的方案。

在 TUI 中清空输入框，用 `↑↓` 选择“Register goal”，然后按 `Enter`。选择“Return to conversation without registering”或按 `Esc` 则不注册，默认选项也是返回对话。日语界面中的这两个选项分别是“登録する”和“登録せずに会話に戻る”。当前界面不提供中文按钮名。

人确认一次后，目标就会注册到选定的 manager，无需在 manager 中再次确认。目标会保存创建来源 `director` 和已确认方案的版本。没有人工确认，AI 发言或发送给 manager 的消息都不能完成注册。

## 通过 Slack 确认

在全局 `~/.takt/config.yaml` 中配置 director 的 Slack 连接：

```yaml
director:
  slack:
    channel_id: C0DIR
    allowed_user_ids: [U0AAA]
```

使用与 manager 相同的 Slack App，并将机器人邀请到 director 频道。在启动 daemon 的 shell 中设置 `TAKT_SLACK_APP_TOKEN` 和 `TAKT_SLACK_BOT_TOKEN`，不要把令牌写进配置文件。修改 Slack 配置后重新启动 daemon。详细步骤参阅[配置指南](./configuration.zh-CN.md#通过-slack-与-director-对话)。

注册方案也会显示在配置的频道中。点击“Register goal”注册，或点击“Return to conversation without registering”取消注册。日语显示分别为“登録する”和“登録せずに会話に戻る”。请确认当前方案，不要使用更改前的旧版本。

`director.slack.allowed_user_ids` 适用于发言、director 的注册按钮和询问按钮。不在列表中的人点击注册按钮也不会注册目标。配置 Slack 时此项必填，空数组表示不接受任何人的发言或操作。manager 的询问操作使用独立的 `manager.slack.allowed_user_ids`。

对获准用户的回复发送到原消息列，新通知按轮次汇总。接受操作与处理完成是两回事，请确认注册结果。未配置 `director.slack` 时，director 不通过 Slack 收发消息。

## 谁来回答问题

通过 director 创建的目标，其普通问题（`routine`）会交给 director，例如在约定范围内选择实现方法。直接在 manager 中开始的目标，问题最初交给人。

即使目标的问题接收方是 director，以下类型也始终交给人：

| 类型 | 需要人工处理的内容 |
|------|--------------------|
| `permission` | 授予权限 |
| `irreversible` | 不可逆操作 |
| `agreement` | 更改约定 |
| `humanTask` | 只有人能完成的工作 |
| `humanFact` | 只有人知道的事实 |
| `unsure` | director 无法确定如何回答的问题 |

director 拿不准时，会通过 `takt_escalate_goal_question` 将该问题以 `unsure` 类型交给人，不改变整个目标的问题接收方。发给人的问题直接出现在 director TUI 和已配置的 Slack 中。在 TUI 中按 `Ctrl+R` 选择问题并回答；在 Slack 中使用问题的选项按钮或消息列回答。director 不代替人回答发给人的问题。

回答者以 `human` 或 `director` 记录在 `answeredBy` 中，与表示回答途径的 `source`（如 `tui`、`slack`、`mcp`）分开。可以要求“显示这个目标的问题和回答”，director 会用 `takt_list_goal_questions` 和 `takt_get_goal_question` 读取包括人工回答在内的历史。

## 交给 director 或交回人

对于在 manager 中开始的目标，可以对 director 说“这个目标交给你”，让它处理普通问题，这称为提升。说“这个目标我自己处理”则将问题交回人。请说明仓库和目标，以便确定对象。

director 只有收到当前人的指示，才会通过 `takt_set_goal_question_route` 更改问题接收方，不会因自己的判断或监测事件自行切换。未回答的问题也会重新分配，但上述六种类型在提升后仍交给人。创建来源 `creationOrigin` 和过去的回答保持不变，`questionRoute` 记录当前的问题接收方。

## 移除 manager（fire）

明确提出“移除博客的 manager”等请求后，director 会确认对象并使用 `takt_fire_manager`。只要负责范围内还有既未完成也未中止的目标，就会拒绝、说明原因，并将 manager 保留在列表中。暂停和等待合并的目标也属于未完成。

成功后，manager 不再出现在 director 列表中，仓库、目标记录、分支和对话都会保留。要恢复，请再次提供同一仓库的绝对路径并要求在那里工作；通过 `takt_add_manager` 重新准备后就会回到列表。没有自动隐藏长期未使用 manager 的机制，也没有专用的恢复操作。

## 不支持的功能

daemon 停止或 PC 休眠期间漏收的 Slack 发言，不会从频道历史中重新读取。Slack 配置引导命令（如 `takt director slack init`）和随附的 director Slack App Manifest 也不在本次范围内。请按配置指南创建 Slack App。

director 不检查仓库内容或 run 内部信息，也不修改各仓库的 `main_merge` 等配置。工作细节由 manager 检查。只有人明确指示合并时，director 才向负责的 manager 转达请求，自己不执行合并。消息已接受不代表合并成功。有关处理方式和限制，参阅 [director CLI 说明](./cli-reference.zh-CN.md#与-manager-的分工和人工决定)。
