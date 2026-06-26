# Coder Decisions

## exec-assistant persona 名の共有について（rename しない判断）

### 決定

workflow 内部 agent（replan, loop-monitor-small, loop-monitor-large）と対話 assistant が persona `exec-assistant` を共有する現状を維持し、rename しない。

### 理由

1. **セッション衝突は発生しない**: 各 agent は異なる `session_key` を持つ（`exec-replan`, `exec-loop-monitor-small`, `exec-loop-monitor-large`）。対話 assistant は `personaName` フィールドでセッションルーティングされる。session_key が異なるため、セッション状態の混同は起きない。

2. **persona facet の共有は設計上正しい**: CLAUDE.md のファセット規約により、`personas/` は WHO（identity, expertise, behavioral habits）のみを格納する。replan、loop-monitor、対話 assistant はいずれも「exec coordinator」として同じ行動特性（冷静なタスク分析、簡潔な報告、ユーザー意図の尊重）を共有する。workflow 固有の手順はタスク指示書 Item 2 で instruction facet に分離済み。

3. **rename による追加コストが利益を上回る**: rename すると、同一内容の persona facet が複数生成される（`exec-coordinator.md`, `exec-supervisor.md` 等）。DRY 原則に反し、facet 管理コストが増加する。

4. **既存の命名予約で混同を防止済み**: `configValidation.ts` の `RESERVED_EXEC_SESSION_KEY_BASES` に `exec-assistant` が含まれており、ユーザー定義の actor 名との衝突は防止されている。

### 関連コード

- `src/features/exec/assistantSession.ts:43` — 対話 assistant の `personaName`
- `src/features/exec/workflowTemplate.ts:61,94,127,140` — workflow agent の `persona` フィールド
- `src/features/exec/configValidation.ts:33` — `RESERVED_EXEC_SESSION_KEY_BASES` に `exec-assistant` 登録
