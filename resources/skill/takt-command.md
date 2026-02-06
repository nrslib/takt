---
name: takt
description: TAKT ピースランナー。ピースYAMLワークフローに従ってマルチエージェントを実行する。
---

TAKT ピースランナーを実行する。

## 引数

$ARGUMENTS を以下のように解析する:

```
/takt {piece} [permission] {task...}
```

- **第1トークン**: ピース名またはYAMLファイルパス（必須）
- **第2トークン**: 権限モード（任意）。以下のキーワードの場合は権限モードとして解釈する:
  - `yolo` — 全権限付与（mode: "bypassPermissions"）
  - 上記以外 → タスク内容の一部として扱う
- **残りのトークン**: タスク内容（省略時は AskUserQuestion でユーザーに入力を求める）
- **権限モード省略時のデフォルト**: `"default"`（権限確認あり）

例:
- `/takt coding FizzBuzzを作って` → coding ピース、default 権限
- `/takt coding yolo FizzBuzzを作って` → coding ピース、bypassPermissions
- `/takt passthrough yolo 全テストを実行` → passthrough ピース、bypassPermissions
- `/takt /path/to/custom.yaml 実装して` → カスタムYAML、default 権限

## 実行手順

以下のファイルを **Read tool で読み込み**、記載された手順に従って実行する:

1. `~/.claude/skills/takt/SKILL.md` - エンジン概要とピース解決
2. `~/.claude/skills/takt/references/engine.md` - 実行エンジンの詳細ロジック
3. `~/.claude/skills/takt/references/yaml-schema.md` - ピースYAML構造リファレンス

**重要**: これら3ファイルを最初に全て読み込んでから、SKILL.md の「手順」に従って処理を開始する。
