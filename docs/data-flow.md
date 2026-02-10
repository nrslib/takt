# TAKTデータフロー解析

このドキュメントでは、TAKTにおけるデータフロー、特にインタラクティブモードからピース実行に至るまでのデータの流れを説明します。

## 目次

1. [概要](#概要)
2. [全体フロー図](#全体フロー図)
3. [各レイヤーの詳細](#各レイヤーの詳細)
4. [データフローの段階](#データフローの段階)
5. [重要な変換ポイント](#重要な変換ポイント)

---

## 概要

TAKTのデータフローは以下の7つの主要なレイヤーで構成されています:

1. **CLI Layer** - ユーザー入力の受付
2. **Interactive Layer** - タスクの対話的な明確化
3. **Execution Orchestration Layer** - ピース選択とworktree管理
4. **Piece Execution Layer** - セッション管理とイベント処理
5. **Engine Layer** - ステートマシンによるステップ実行
6. **Instruction Building Layer** - プロンプト生成
7. **Provider Layer** - AIプロバイダーとの通信

---

## 全体フロー図

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. CLI Layer (src/app/cli/index.ts)                             │
│   ユーザー入力 → 引数パース → コマンド振り分け                       │
└────────────────────────────┬────────────────────────────────────┘
                             │
                ┌────────────┴──────────────┐
                │                           │
     Direct Task Input            Short Input / No Args
                │                           │
                │                           ▼
                │              ┌─────────────────────────────────┐
                │              │ 2. Interactive Layer            │
                │              │    (interactive.ts)             │
                │              │                                 │
                │              │  ┌─────────────────────┐        │
                │              │  │ User Conversation   │        │
                │              │  │  - Clarification    │        │
                │              │  │  - Codebase Search  │        │
                │              │  │  - AI Response      │        │
                │              │  └──────┬──────────────┘        │
                │              │         │                        │
                │              │         ▼                        │
                │              │  User confirms with /go          │
                │              │         │                        │
                │              │         ▼                        │
                │              │  buildTaskFromHistory()          │
                │              │  (会話履歴 → タスク文字列)         │
                │              └─────────┬───────────────────────┘
                │                        │
                └────────────────────────┘
                             │
                             │ task: string
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Execution Orchestration Layer                                │
│    (selectAndExecute.ts)                                        │
│                                                                 │
│  ┌──────────────────────┐                                      │
│  │ determinePiece()  │ ← piece選択 (interactive/override) │
│  └─────────┬────────────┘                                      │
│            │ pieceIdentifier: string                        │
│            ▼                                                    │
│  ┌──────────────────────────────────┐                         │
│  │ confirmAndCreateWorktree()       │                         │
│  │  - AI branchname generation      │                         │
│  │  - createSharedClone()           │                         │
│  └─────────┬────────────────────────┘                         │
│            │ { execCwd, isWorktree, branch }                  │
│            ▼                                                    │
│  ┌──────────────────────────────────┐                         │
│  │ executeTask()                    │                         │
│  │  - task: string                  │                         │
│  │  - cwd: string (実行ディレクトリ)   │                         │
│  │  - pieceIdentifier: string    │                         │
│  │  - projectCwd: string (.takt/在処) │                         │
│  └─────────┬────────────────────────┘                         │
└────────────┼────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Piece Execution Layer                                     │
│    (pieceExecution.ts, taskExecution.ts)                     │
│                                                                 │
│  ┌────────────────────────────────┐                            │
│  │ loadPieceByIdentifier()     │                            │
│  │  → PieceConfig              │                            │
│  └────────┬───────────────────────┘                            │
│           │                                                     │
│           ▼                                                     │
│  ┌────────────────────────────────┐                            │
│  │ Session Management             │                            │
│  │  - loadAgentSessions()         │ ← projectCwd or cwd       │
│  │  - generateSessionId()         │                            │
│  │  - createSessionLog()          │                            │
│  │  - initNdjsonLog()             │                            │
│  └────────┬───────────────────────┘                            │
│           │                                                     │
│           ▼                                                     │
│  ┌────────────────────────────────┐                            │
│  │ PieceEngine initialization  │                            │
│  │                                │                            │
│  │  new PieceEngine(           │                            │
│  │    config: PieceConfig,     │                            │
│  │    cwd: string,                │                            │
│  │    task: string,               │                            │
│  │    options: {                  │                            │
│  │      onStream,                 │ ← StreamDisplay handler   │
│  │      initialSessions,          │ ← 保存済みセッションID      │
│  │      onSessionUpdate,          │ ← セッション更新callback    │
│  │      projectCwd,               │                            │
│  │      language,                 │                            │
│  │      provider,                 │                            │
│  │      model                     │                            │
│  │    }                           │                            │
│  │  )                             │                            │
│  └────────┬───────────────────────┘                            │
│           │                                                     │
│           ▼                                                     │
│  ┌────────────────────────────────┐                            │
│  │ Event Subscription             │                            │
│  │  - step:start                  │                            │
│  │  - step:complete               │                            │
│  │  - step:report                 │                            │
│  │  - piece:complete           │                            │
│  │  - piece:abort              │                            │
│  └────────┬───────────────────────┘                            │
│           │                                                     │
│           ▼                                                     │
│  ┌────────────────────────────────┐                            │
│  │ engine.run()                   │                            │
│  └────────┬───────────────────────┘                            │
└───────────┼─────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. Engine Layer (PieceEngine.ts)                             │
│                                                                 │
│  ┌────────────────────────────────────────┐                    │
│  │ State Machine Loop                     │                    │
│  │                                        │                    │
│  │  while (state.status === 'running') {  │                    │
│  │    ┌────────────────────────────────┐ │                    │
│  │    │ 1. Iteration & Loop Check      │ │                    │
│  │    └────────────┬───────────────────┘ │                    │
│  │                 │                      │                    │
│  │                 ▼                      │                    │
│  │    ┌────────────────────────────────┐ │                    │
│  │    │ 2. Get Current Step            │ │                    │
│  │    │    step = getStep(             │ │                    │
│  │    │      state.currentStep         │ │                    │
│  │    │    )                           │ │                    │
│  │    └────────────┬───────────────────┘ │                    │
│  │                 │                      │                    │
│  │                 ▼                      │                    │
│  │    ┌────────────────────────────────┐ │                    │
│  │    │ 3. Build Instruction           │ │ ← InstructionBuilder
│  │    │    (if not parallel)           │ │                    │
│  │    └────────────┬───────────────────┘ │                    │
│  │                 │                      │                    │
│  │                 ▼                      │                    │
│  │    ┌────────────────────────────────┐ │                    │
│  │    │ 4. Emit step:start             │ │                    │
│  │    └────────────┬───────────────────┘ │                    │
│  │                 │                      │                    │
│  │                 ▼                      │                    │
│  │    ┌────────────────────────────────┐ │                    │
│  │    │ 5. runStep()                   │ │                    │
│  │    │    ├─ Normal: StepExecutor     │ │ ← 3-phase execution
│  │    │    └─ Parallel: ParallelRunner │ │                    │
│  │    └────────────┬───────────────────┘ │                    │
│  │                 │                      │                    │
│  │                 │ { response, instruction }                │
│  │                 ▼                      │                    │
│  │    ┌────────────────────────────────┐ │                    │
│  │    │ 6. Emit step:complete          │ │                    │
│  │    └────────────┬───────────────────┘ │                    │
│  │                 │                      │                    │
│  │                 ▼                      │                    │
│  │    ┌────────────────────────────────┐ │                    │
│  │    │ 7. Handle Blocked              │ │                    │
│  │    │    (if status === 'blocked')   │ │                    │
│  │    └────────────┬───────────────────┘ │                    │
│  │                 │                      │                    │
│  │                 ▼                      │                    │
│  │    ┌────────────────────────────────┐ │                    │
│  │    │ 8. Rule Evaluation             │ │ ← RuleEvaluator   │
│  │    │    resolveNextStep()           │ │                    │
│  │    └────────────┬───────────────────┘ │                    │
│  │                 │                      │                    │
│  │                 │ nextStep: string     │                    │
│  │                 ▼                      │                    │
│  │    ┌────────────────────────────────┐ │                    │
│  │    │ 9. Transition                  │ │                    │
│  │    │    - COMPLETE → break          │ │                    │
│  │    │    - ABORT → break             │ │                    │
│  │    │    - other → update state      │ │                    │
│  │    └────────────────────────────────┘ │                    │
│  │  }                                     │                    │
│  └────────────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
            │
            ▼ (from runStep)
┌─────────────────────────────────────────────────────────────────┐
│ 6. Instruction Building & Step Execution Layer                  │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐│
│  │ StepExecutor.runNormalStep()                               ││
│  │                                                            ││
│  │  ┌──────────────────────────────────────────────────────┐ ││
│  │  │ Phase 1: Main Execution                              │ ││
│  │  │                                                      │ ││
│  │  │  InstructionBuilder.build()                         │ ││
│  │  │    ├─ Execution Context (cwd, permission)           │ ││
│  │  │    ├─ Piece Context (iteration, step, report)    │ ││
│  │  │    ├─ User Request ({task})                         │ ││
│  │  │    ├─ Previous Response ({previous_response})       │ ││
│  │  │    ├─ Additional User Inputs ({user_inputs})        │ ││
│  │  │    ├─ Instructions (instruction_template)           │ ││
│  │  │    └─ Status Output Rules (tag-based)               │ ││
│  │  │                                                      │ ││
│  │  │  → instruction: string                              │ ││
│  │  │                                                      │ ││
│  │  │  runAgent(agent, instruction, options)              │ ││
│  │  │    → response: AgentResponse                        │ ││
│  │  └──────────────────────┬───────────────────────────────┘ ││
│  │                         │                                  ││
│  │                         ▼                                  ││
│  │  ┌──────────────────────────────────────────────────────┐ ││
│  │  │ Phase 2: Report Output (if step.report defined)     │ ││
│  │  │                                                      │ ││
│  │  │  runReportPhase()                                   │ ││
│  │  │    - Resume session                                 │ ││
│  │  │    - Write-only tools                               │ ││
│  │  │    - ReportInstructionBuilder                       │ ││
│  │  └──────────────────────┬───────────────────────────────┘ ││
│  │                         │                                  ││
│  │                         ▼                                  ││
│  │  ┌──────────────────────────────────────────────────────┐ ││
│  │  │ Phase 3: Status Judgment (if tag-based rules)       │ ││
│  │  │                                                      │ ││
│  │  │  runStatusJudgmentPhase()                           │ ││
│  │  │    - Resume session                                 │ ││
│  │  │    - No tools (judgment only)                       │ ││
│  │  │    - StatusJudgmentBuilder                          │ ││
│  │  │    → tagContent: string                             │ ││
│  │  └──────────────────────┬───────────────────────────────┘ ││
│  │                         │                                  ││
│  │                         ▼                                  ││
│  │  ┌──────────────────────────────────────────────────────┐ ││
│  │  │ Rule Evaluation                                      │ ││
│  │  │                                                      │ ││
│  │  │  detectMatchedRule(step, content, tagContent)       │ ││
│  │  │    1. Aggregate (all()/any())                       │ ││
│  │  │    2. Phase 3 tag ([STEP:N])                        │ ││
│  │  │    3. Phase 1 tag (fallback)                        │ ││
│  │  │    4. AI judge (ai("..."))                          │ ││
│  │  │    5. AI judge fallback (all conditions)            │ ││
│  │  │    → { index, method }                              │ ││
│  │  └──────────────────────┬───────────────────────────────┘ ││
│  │                         │                                  ││
│  │                         ▼                                  ││
│  │  response with matchedRuleIndex & matchedRuleMethod        ││
│  └────────────────────────────────────────────────────────────┘│
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 7. Provider Layer (agents/runner.ts → providers/)               │
│                                                                 │
│  ┌────────────────────────────────────────┐                    │
│  │ runAgent()                             │                    │
│  │  - Resolve agent spec                  │                    │
│  │  - Get provider                        │                    │
│  │  - Call provider.call()                │                    │
│  └────────────┬───────────────────────────┘                    │
│               │                                                 │
│               ▼                                                 │
│  ┌────────────────────────────────────────┐                    │
│  │ Provider.call()                        │                    │
│  │  (ClaudeProvider / CodexProvider)      │                    │
│  │                                        │                    │
│  │  - Build system prompt                 │                    │
│  │  - Call SDK (callClaude / callCodex)   │                    │
│  │  - Stream handling (onStream callback) │                    │
│  │  - Error propagation                   │                    │
│  │                                        │                    │
│  │  → { status, content, sessionId, ... } │                    │
│  └────────────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 各レイヤーの詳細

### 1. CLI Layer (`src/app/cli/index.ts`)

**役割**: ユーザー入力の受付とコマンド振り分け

**主要な処理**:
- コマンドライン引数のパース
- 入力タイプの判定:
  - `isDirectTask()`: 複数単語またはissue参照 → 直接実行
  - 短い単語または引数なし → インタラクティブモード
- グローバル設定の初期化 (`initGlobalDirs`, `initProjectDirs`)
- パイプラインモード vs 通常モードの判定

**データ入力**:
- CLI引数: `task`, `--piece`, `--issue`, など

**データ出力**:
- `task: string` (タスク記述)
- `piece: string | undefined` (ピース名またはパス)
- `createWorktree: boolean | undefined`
- その他オプション

---

### 2. Interactive Layer (`src/features/interactive/interactive.ts`)

**役割**: タスクの対話的な明確化

**主要な処理**:
1. **会話ループ**:
   - `readLine()`: ユーザー入力を1行ずつ読み込み
   - `callAI()`: AIプロバイダーを呼び出し
   - 履歴管理: `ConversationMessage[]`

2. **セッション管理**:
   - `loadAgentSessions()`: 過去のセッションを復元
   - `updateAgentSession()`: セッションIDを更新・保存

3. **スラッシュコマンド**:
   - `/go`: タスク確定、実行へ進む
   - `/cancel`: キャンセル
   - `Ctrl+D`: EOF、キャンセル

4. **タスク組み立て**:
   - `buildTaskFromHistory()`: 会話履歴を結合してタスク文字列を生成

**データ入力**:
- `initialInput?: string` (CLI引数から)
- ユーザーの対話入力

**データ出力**:
- `InteractiveModeResult`:
  - `action: InteractiveModeAction` (`'execute' | 'save_task' | 'create_issue' | 'cancel'`)
  - `task: string` (会話履歴全体を結合した文字列)

---

### 3. Execution Orchestration Layer (`src/features/tasks/execute/selectAndExecute.ts`)

**役割**: ピース選択とworktree管理

**主要な処理**:

1. **ピース決定** (`determinePiece()`):
   - オーバーライド指定がある場合:
     - パス形式 → そのまま使用
     - 名前形式 → バリデーション
   - オーバーライドなし → インタラクティブ選択 (`selectPiece()`)

2. **Worktree作成** (`confirmAndCreateWorktree()`):
   - ユーザー確認 (または `--create-worktree` フラグ)
   - ブランチ名生成 (`summarizeTaskName()` - AIでタスクから英語スラグ生成)
   - `createSharedClone()`: git clone --shared で軽量クローン作成

3. **タスク実行開始** (`selectAndExecuteTask()`):
   - `executeTask()` を呼び出し
   - 成功時: Auto-commit & Push
   - PR作成 (オプション)

**データ入力**:
- `task: string`
- `options?: SelectAndExecuteOptions`:
  - `piece?: string`
  - `createWorktree?: boolean`
  - `autoPr?: boolean`
- `agentOverrides?: TaskExecutionOptions`

**データ出力**:
- `{ execCwd, isWorktree, branch }`
- タスク実行成功/失敗

---

### 4. Piece Execution Layer

#### 4.1 Task Execution (`src/features/tasks/execute/taskExecution.ts`)

**役割**: ピース読み込みと実行の橋渡し

**主要な処理**:
1. `loadPieceByIdentifier()`: YAMLまたは名前からピース設定を読み込み
2. `executePiece()` を呼び出し

**データ入力**:
- `ExecuteTaskOptions`:
  - `task: string`
  - `cwd: string` (実行ディレクトリ、cloneまたはプロジェクトルート)
  - `pieceIdentifier: string`
  - `projectCwd: string` (`.takt/`がある場所)
  - `agentOverrides?: TaskExecutionOptions`

**データ出力**:
- `boolean` (成功/失敗)

#### 4.2 Piece Execution (`src/features/tasks/execute/pieceExecution.ts`)

**役割**: セッション管理、イベント購読、ログ記録

**主要な処理**:

1. **セッション管理**:
   - `generateSessionId()`: ピースセッションID生成
   - `loadAgentSessions()` / `loadWorktreeSessions()`: エージェントセッション復元
   - `updateAgentSession()` / `updateWorktreeSession()`: セッション保存

2. **ログ初期化**:
   - `createSessionLog()`: セッションログオブジェクト作成
   - `initNdjsonLog()`: NDJSON形式のログファイル初期化
   - `meta.json` 更新: 実行ステータス（running/completed/aborted）と時刻を保存

3. **PieceEngine初期化**:
   ```typescript
   new PieceEngine(pieceConfig, cwd, task, {
     onStream: streamHandler,           // UI表示用ストリームハンドラ
     initialSessions: savedSessions,    // 保存済みセッションID
     onSessionUpdate: sessionUpdateHandler,
     onIterationLimit: iterationLimitHandler,
     projectCwd,
     language,
     provider,
     model
   })
   ```

4. **イベント購読**:
   - `step:start`: ステップ開始 → UI表示、NDJSON記録
   - `step:complete`: ステップ完了 → UI表示、NDJSON記録、セッション更新
   - `step:report`: レポートファイル出力
   - `piece:complete`: ピース完了 → 通知
   - `piece:abort`: ピース中断 → エラー通知

5. **SIGINT処理**:
   - 1回目: Graceful abort (`engine.abort()`)
   - 2回目: 強制終了

**データ入力**:
- `PieceConfig`
- `task: string`
- `cwd: string`
- `PieceExecutionOptions`

**データ出力**:
- `PieceExecutionResult`:
  - `success: boolean`
  - `reason?: string`

---

### 5. Engine Layer (`src/core/piece/engine/PieceEngine.ts`)

**役割**: ステートマシンによるピース実行制御

**主要な構成要素**:

1. **State管理** (`PieceState`):
   - `status`: 'running' | 'completed' | 'aborted'
   - `currentStep`: 現在実行中のステップ名
   - `iteration`: ピース全体のイテレーション数
   - `stepIterations`: Map<stepName, count> (ステップごとの実行回数)
   - `agentSessions`: Map<agent, sessionId> (エージェントごとのセッションID)
   - `stepOutputs`: Map<stepName, AgentResponse> (各ステップの出力)
   - `userInputs`: string[] (blocked時のユーザー追加入力)

2. **コンポーネント**:
   - `OptionsBuilder`: エージェント実行オプション構築
   - `StepExecutor`: 通常ステップの3フェーズ実行
   - `ParallelRunner`: 並列ステップの実行

3. **主要メソッド**:

   **`run()`**: メインループ
   ```typescript
   while (state.status === 'running') {
     // 1. Abort & Iteration チェック
     if (abortRequested) { ... }
     if (iteration >= maxIterations) { ... }

     // 2. ステップ取得
     const step = getStep(state.currentStep);

     // 3. ループ検出
     const loopCheck = loopDetector.check(step.name);

     // 4. インストラクション構築 (非並列の場合)
     const instruction = stepExecutor.buildInstruction(...);

     // 5. イベント発行
     emit('step:start', step, iteration, instruction);

     // 6. ステップ実行
     const { response, instruction } = await runStep(step, instruction);

     // 7. イベント発行
     emit('step:complete', step, response, instruction);

     // 8. Blocked処理
     if (response.status === 'blocked') { ... }

     // 9. ルール評価
     const nextStep = resolveNextStep(step, response);

     // 10. 遷移
     if (nextStep === COMPLETE_STEP) { break; }
     if (nextStep === ABORT_STEP) { break; }
     state.currentStep = nextStep;
   }
   ```

   **`runStep()`**: ステップ実行の委譲
   - 並列ステップ → `ParallelRunner.runParallelStep()`
   - 通常ステップ → `StepExecutor.runNormalStep()`

   **`resolveNextStep()`**: ルール評価によるステップ遷移決定
   - `response.matchedRuleIndex` を使用
   - `determineNextStepByRules()` で次ステップ名を取得

**データ入力**:
- `PieceConfig`
- `cwd: string`
- `task: string`
- `PieceEngineOptions`

**データ出力**:
- `PieceState` (最終状態)
- イベント発行 (各ステップの進捗)

---

### 6. Instruction Building & Step Execution Layer

#### 6.1 Step Execution (`src/core/piece/engine/StepExecutor.ts`)

**役割**: 3フェーズモデルによるステップ実行

**3フェーズの詳細**:

**Phase 1: Main Execution**
- 目的: エージェントのメインタスク実行
- Tools: ステップで指定されたツール (ただし `step.report` がある場合は Write を除外)
- インストラクション: `InstructionBuilder.build()`

**Phase 2: Report Output** (オプション、`step.report` がある場合のみ)
- 目的: レポートファイルへの出力
- Tools: **Writeのみ**
- インストラクション: `ReportInstructionBuilder.build()`
- セッション: Phase 1と同じセッションを継続 (resume)

**Phase 3: Status Judgment** (オプション、tag-based rulesがある場合のみ)
- 目的: ステータスタグの出力
- Tools: **なし** (判断のみ)
- インストラクション: `StatusJudgmentBuilder.build()`
- セッション: Phase 1と同じセッションを継続 (resume)
- 出力: `[STEP:N]` 形式のタグ

**主要メソッド**:

**`runNormalStep()`**:
```typescript
// Phase 1
const response = await runAgent(step.agent, instruction, options);
updateAgentSession(step.agent, response.sessionId);

// Phase 2 (if step.report)
if (step.report) {
  await runReportPhase(step, stepIteration, context);
}

// Phase 3 (if tag-based rules)
let tagContent = '';
if (needsStatusJudgmentPhase(step)) {
  tagContent = await runStatusJudgmentPhase(step, context);
}

// Rule evaluation
const match = await detectMatchedRule(step, response.content, tagContent, {...});
```

**`buildInstruction()`**:
- `InstructionBuilder` を使用してインストラクション文字列を生成
- コンテキスト情報を渡す

#### 6.2 Instruction Building (`src/core/piece/instruction/InstructionBuilder.ts`)

**役割**: Phase 1用のインストラクション文字列生成

**自動注入セクション**:

1. **Execution Context** (実行環境メタデータ):
   - Working directory
   - Permission rules (edit mode)

2. **Piece Context**:
   - Iteration (piece-wide)
   - Step Iteration (per-step)
   - Step name
   - Report Directory/File info
   - Run Source Paths (`.takt/runs/{slug}/context/...`)

3. **User Request** (タスク本文):
   - `{task}` プレースホルダーがテンプレートにない場合のみ自動注入

4. **Previous Response** (前ステップの出力):
   - `step.passPreviousResponse === true` かつ
   - `{previous_response}` プレースホルダーがテンプレートにない場合のみ自動注入
   - 長さ制御（2000 chars）と `...TRUNCATED...` を適用
   - Source Path を常時注入

5. **Additional User Inputs** (blocked時の追加入力):
   - `{user_inputs}` プレースホルダーがテンプレートにない場合のみ自動注入

6. **Instructions** (ステップ固有のテンプレート):
   - `step.instructionTemplate` の内容
   - プレースホルダー置換: `{task}`, `{previous_response}`, `{iteration}`, など

7. **Status Output Rules** (tag-based rules用):
   - `hasTagBasedRules(step)` の場合のみ
   - `generateStatusRulesFromRules()` で生成

**プレースホルダー置換**:
- `{task}`: ユーザーリクエスト
- `{previous_response}`: 前ステップの出力
- `{user_inputs}`: 追加ユーザー入力
- `{iteration}`: ピース全体のイテレーション
- `{max_iterations}`: 最大イテレーション
- `{step_iteration}`: ステップのイテレーション
- `{report_dir}`: レポートディレクトリ

**ロケール対応**:
- `language: 'en' | 'ja'`
- セクション見出しや説明文が言語に応じて切り替わる

---

### 7. Provider Layer

#### 7.1 Agent Runner (`src/agents/runner.ts`)

**役割**: エージェント仕様の解決とプロバイダー呼び出し

**主要な処理**:
1. **エージェント仕様解決**:
   - ビルトインエージェント (`coder`, `architect`, など)
   - カスタムエージェント (`.takt/agents.yaml`)
   - プロンプトファイル (`.md`)

2. **プロバイダー取得**:
   - `getProvider(providerType)`: ClaudeProvider / CodexProvider / MockProvider

3. **エージェント呼び出し**:
   - `provider.call(agentName, instruction, options)`

**データ入力**:
- `agent: string` (エージェント名またはパス)
- `instruction: string` (構築済みインストラクション)
- `AgentRunOptions`:
  - `cwd: string`
  - `sessionId?: string`
  - `allowedTools?: string[]`
  - `provider?: ProviderType`
  - `model?: string`
  - `onStream?: StreamHandler`

**データ出力**:
- `AgentResponse`:
  - `agent: string`
  - `status: 'success' | 'blocked'`
  - `content: string`
  - `sessionId?: string`
  - `error?: string`
  - `timestamp: Date`

#### 7.2 Provider (`src/infra/providers/`)

**役割**: AIプロバイダー(Claude, Codex)とのSDK通信

**主要なプロバイダー**:
- `ClaudeProvider`: Claude Code SDK (`@anthropic-ai/claude-agent-sdk`)
- `CodexProvider`: Codex API
- `MockProvider`: テスト用

**主要メソッド**:

**`call()`**:
```typescript
async call(
  agentName: string,
  instruction: string,
  options: ProviderCallOptions
): Promise<AgentResponse>
```

**処理内容**:
1. システムプロンプト構築
2. SDK呼び出し (`callClaude()` / `callCodex()`)
3. ストリーミング処理 (`onStream` callback)
4. エラーハンドリング
5. レスポンス変換

**データ入力**:
- `agentName: string`
- `instruction: string`
- `ProviderCallOptions`:
  - `cwd: string`
  - `sessionId?: string`
  - `systemPrompt?: string`
  - `allowedTools?: string[]`
  - `model?: string`
  - `onStream?: StreamHandler`

**データ出力**:
- `AgentResponse` (上記と同じ)

---

## データフローの段階

### ステージ1: タスク入力

**入力方法**:
1. **直接タスク**: `takt "Fix the login bug"`
2. **Issue参照**: `takt #123`
3. **インタラクティブモード**: `takt` または `takt a`

**データ変換**:
- インタラクティブモード: `ConversationMessage[]` → `task: string`
  - `buildTaskFromHistory()`: 会話履歴を結合

**出力**: `task: string`

---

### ステージ2: 実行環境準備

**ピース選択**:
- `--piece` フラグ → 検証
- なし → インタラクティブ選択 (`selectPiece()`)

**Worktree作成** (オプション):
- `confirmAndCreateWorktree()`:
  - ユーザー確認または `--create-worktree` フラグ
  - `summarizeTaskName()`: タスク → 英語スラグ (AI呼び出し)
  - `createSharedClone()`: git clone --shared

**データ**:
- `pieceIdentifier: string`
- `{ execCwd, isWorktree, branch }`

---

### ステージ3: ピース実行初期化

**セッション管理**:
- `loadAgentSessions()`: 保存済みセッション復元
- `generateSessionId()`: ピースセッションID生成
- `initNdjsonLog()`: NDJSON ログファイル作成

**PieceEngine作成**:
```typescript
new PieceEngine(pieceConfig, cwd, task, {
  onStream,
  initialSessions,
  onSessionUpdate,
  projectCwd,
  language,
  provider,
  model
})
```

**データ**:
- `PieceState`: 初期状態
  - `currentStep = config.initialStep`
  - `iteration = 0`
  - `agentSessions = initialSessions`

---

### ステージ4: ステップ実行ループ

**各イテレーション**:

1. **ステップ取得**: `getStep(state.currentStep)`
2. **インストラクション構築**: `InstructionBuilder.build()`
3. **ステップ実行**: 3フェーズ実行
4. **ルール評価**: `detectMatchedRule()`
5. **ステップ遷移**: `resolveNextStep()` → 次のステップ名

**データ変換**:
- `task + context` → `instruction: string`
- `instruction` → `AgentResponse` (via Provider)
- `AgentResponse + rules` → `matchedRuleIndex`
- `matchedRuleIndex` → `nextStep: string`

---

### ステージ5: インストラクション生成

**InstructionBuilder処理**:

1. **コンテキスト収集**:
   - `task`: 元のユーザーリクエスト
   - `iteration`, `maxIterations`: イテレーション情報
   - `stepIteration`: ステップごとの実行回数
   - `cwd`, `projectCwd`: ディレクトリ情報
   - `userInputs`: blocked時の追加入力
   - `previousOutput`: 前ステップの出力
   - `reportDir`: レポートディレクトリ

2. **セクション組み立て**:
   - 自動注入セクション (上記7つ)
   - プレースホルダー置換

3. **出力**: 完全なインストラクション文字列

---

### ステージ6: エージェント実行

**Phase 1: Main Execution**:
- `runAgent()` → `provider.call()`
- ストリーミング → `onStream` callback → UI表示
- 結果: `AgentResponse`

**Phase 2: Report Output** (オプション):
- 同じセッションを継続 (resume)
- Write-only ツール
- レポートファイル出力

**Phase 3: Status Judgment** (オプション):
- 同じセッションを継続 (resume)
- ツールなし
- `[STEP:N]` タグ出力

---

### ステージ7: ルール評価と遷移

**ルール評価** (`detectMatchedRule()`):

5段階のフォールバック:
1. **Aggregate** (`all()`/`any()`) - 並列ステップ用
2. **Phase 3 tag** - `[STEP:N]` from status judgment
3. **Phase 1 tag** - `[STEP:N]` from main output (fallback)
4. **AI judge** - `ai("condition text")` rules
5. **AI judge fallback** - すべての条件をAIで評価

**出力**: `{ index: number, method: RuleMatchMethod }`

**遷移**:
- `determineNextStepByRules()`: `rules[index].next` を取得
- 特殊ステップ:
  - `COMPLETE`: ピース完了
  - `ABORT`: ピース中断
- 通常ステップ: `state.currentStep = nextStep`

---

## 重要な変換ポイント

### 1. 会話履歴 → タスク文字列

**場所**: `src/features/interactive/interactive.ts`

```typescript
function buildTaskFromHistory(history: ConversationMessage[]): string {
  return history
    .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
    .join('\n\n');
}
```

**重要性**: インタラクティブモードで蓄積された会話全体が、後続のピース実行で単一の `task` 文字列として扱われる。

---

### 2. タスク → ブランチスラグ (AI生成)

**場所**: `src/infra/task/summarize.ts` (呼び出し: `selectAndExecute.ts`, `taskExecution.ts`)

```typescript
await summarizeTaskName(task, { cwd })
```

**処理**:
- タスク文字列をAIに渡す
- 英語の短いスラグに要約 (例: `fix-login-bug`)
- ブランチ名として使用

**重要性**: ユーザーが日本語でタスクを書いても、Git-friendlyなブランチ名が自動生成される。

---

### 3. ピース設定 → PieceState

**場所**: `src/core/piece/engine/state-manager.ts`

```typescript
function createInitialState(
  config: PieceConfig,
  options: PieceEngineOptions
): PieceState {
  return {
    status: 'running',
    currentStep: config.initialStep,
    iteration: 0,
    stepIterations: new Map(),
    agentSessions: new Map(Object.entries(options.initialSessions ?? {})),
    stepOutputs: new Map(),
    userInputs: [],
  };
}
```

**重要性**: YAMLで定義された静的な設定が、実行時のミュータブルな状態に変換される。

---

### 4. コンテキスト → インストラクション文字列

**場所**: `src/core/piece/instruction/InstructionBuilder.ts`

**入力**:
- `step: PieceStep`
- `context: InstructionContext` (task, iteration, previousOutput, userInputs, など)

**処理**:
1. 7つのセクションを組み立て
2. プレースホルダー置換
3. ロケール対応

**出力**: 完全なMarkdown形式のインストラクション文字列

**重要性**: 散在するコンテキスト情報が、エージェントが理解できる単一の文字列に統合される。

---

### 5. AgentResponse → ルールマッチ

**場所**: `src/core/piece/evaluation/RuleEvaluator.ts`

**入力**:
- `step: PieceStep`
- `content: string` (Phase 1 output)
- `tagContent: string` (Phase 3 output)
- `state: PieceState`

**処理**:
1. タグ検出 (`[STEP:0]`, `[STEP:1]`, ...)
2. AI判断 (`ai("condition")` ルール)
3. 集約評価 (`all()`, `any()`)

**出力**: `{ index: number, method: RuleMatchMethod } | null`

**重要性**: 自然言語の出力が、構造化されたステップ遷移決定に変換される。

---

### 6. ルールマッチ → 次ステップ名

**場所**: `src/core/piece/engine/transitions.ts`

```typescript
function determineNextStepByRules(
  step: PieceStep,
  matchedRuleIndex: number
): string | null {
  const rule = step.rules?.[matchedRuleIndex];
  return rule?.next ?? null;
}
```

**重要性**: インデックス番号が、実際に実行すべきステップ名に変換される。

---

### 7. Provider Response → AgentResponse

**場所**: `src/infra/providers/claude.ts`, `src/infra/providers/codex.ts`

**入力**: SDKレスポンス (`ClaudeResult`)

**処理**:
- `status` 変換
- `content` 抽出
- `error` 伝播 (重要！)
- `sessionId` 保存

**出力**: `AgentResponse` (統一インターフェース)

**重要性**: 異なるプロバイダーのレスポンスが統一形式に正規化される。

---

## まとめ

TAKTのデータフローは、**7つのレイヤー**を通じて、ユーザーの自然な入力を段階的に変換し、最終的にAIエージェントの協調的な実行に変えていきます。

**主要な設計原則**:

1. **Progressive Transformation**: データは各レイヤーで少しずつ変換され、次のレイヤーに渡される
2. **Context Accumulation**: タスク、イテレーション、ユーザー入力などのコンテキストが蓄積される
3. **Session Continuity**: エージェントセッションIDが保存・復元され、会話の継続性を保つ
4. **Event-Driven Architecture**: PieceEngineがイベントを発行し、UI、ログ、通知が連携
5. **3-Phase Execution**: メイン実行、レポート出力、ステータス判断の3段階で、明確な責任分離
6. **Rule-Based Routing**: ルール評価の5段階フォールバックで、柔軟かつ予測可能な遷移

このアーキテクチャにより、TAKTは複雑な多エージェント協調を、ユーザーには透明で、開発者には拡張可能な形で実現しています。
