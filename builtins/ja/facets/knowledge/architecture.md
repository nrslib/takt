# アーキテクチャ知識

## 構造・設計

**ファイル分割**

| 基準           | 判定 |
|--------------|------|
| 1ファイル200行超   | 分割を検討 |
| 1ファイル300行超   | REJECT |
| 1ファイルに複数の責務  | REJECT |
| 関連性の低いコードが同居 | REJECT |

**モジュール構成**

- 高凝集: 関連する機能がまとまっているか
- 低結合: モジュール間の依存が最小限か
- 循環依存がないか
- 適切なディレクトリ階層か

**操作の一覧性**

同じ汎用関数への呼び出しがコードベースに散在すると、システムが何をしているか把握できなくなる。操作には目的に応じた名前を付けて関数化し、関連する操作を1つのモジュールにまとめる。そのモジュールを読めば「このシステムが行う操作の全体像」がわかる状態にする。

| 判定 | 基準 |
|------|------|
| REJECT | 同じ汎用関数が目的の異なる3箇所以上から直接呼ばれている |
| REJECT | 呼び出し元を全件 grep しないとシステムの操作一覧がわからない |
| OK | 目的ごとに名前付き関数が定義され、1モジュールに集約されている |

**パブリック API の公開範囲**

パブリック API が公開するのは、ドメインの操作に対応する関数・型のみ。インフラの実装詳細（特定プロバイダーの関数、内部パーサー等）を公開しない。

| 判定 | 基準 |
|------|------|
| REJECT | インフラ層の関数がパブリック API からエクスポートされている |
| REJECT | 内部実装の関数が外部から直接呼び出し可能になっている |
| OK | 外部消費者がドメインレベルの抽象のみを通じて対話する |

**関数設計**

- 1関数1責務になっているか
- 30行を超える関数は分割を検討
- 副作用が明確か

**レイヤー設計**

- 依存の方向: 上位層 → 下位層（逆方向禁止）
- Controller → Service → Repository の流れが守られているか
- 1インターフェース = 1責務（巨大なServiceクラス禁止）

**ディレクトリ構造**

構造パターンの選択:

| パターン | 適用場面 | 例 |
|---------|---------|-----|
| レイヤード | 小規模、CRUD中心 | `controllers/`, `services/`, `repositories/` |
| Vertical Slice | 中〜大規模、機能独立性が高い | `features/auth/`, `features/order/` |
| ハイブリッド | 共通基盤 + 機能モジュール | `core/` + `features/` |

Vertical Slice Architecture（機能単位でコードをまとめる構造）:

```
src/
├── features/
│   ├── auth/
│   │   ├── LoginCommand.ts
│   │   ├── LoginHandler.ts
│   │   ├── AuthRepository.ts
│   │   └── auth.test.ts
│   └── order/
│       ├── CreateOrderCommand.ts
│       ├── CreateOrderHandler.ts
│       └── ...
└── shared/           # 複数featureで共有
    ├── database/
    └── middleware/
```

Vertical Slice の判定基準:

| 基準 | 判定 |
|------|------|
| 1機能が3ファイル以上のレイヤーに跨る | Slice化を検討 |
| 機能間の依存がほぼない | Slice化推奨 |
| 共通処理が50%以上 | レイヤード維持 |
| チームが機能別に分かれている | Slice化必須 |

禁止パターン:

| パターン | 問題 |
|---------|------|
| `utils/` の肥大化 | 責務不明の墓場になる |
| `common/` への安易な配置 | 依存関係が不明確になる |
| 深すぎるネスト（4階層超） | ナビゲーション困難 |
| 機能とレイヤーの混在 | `features/services/` は禁止 |

**責務の分離**

- 読み取りと書き込みの責務が分かれているか
- データ取得はルート（View/Controller）で行い、子に渡しているか
- エラーハンドリングが一元化されているか（各所でtry-catch禁止）
- ビジネスロジックがController/Viewに漏れていないか

## コード品質の検出手法

**説明コメント（What/How）の検出基準**

コードの動作をそのまま言い換えているコメントを検出する。

| 判定 | 基準 |
|------|------|
| REJECT | コードの動作をそのまま自然言語で言い換えている |
| REJECT | 関数名・変数名から明らかなことを繰り返している |
| REJECT | JSDocが関数名の言い換えだけで情報を追加していない |
| OK | なぜその実装を選んだかの設計判断を説明している |
| OK | 一見不自然に見える挙動の理由を説明している |
| 最良 | コメントなしでコード自体が意図を語っている |

```typescript
// REJECT - コードの言い換え（What）
// If interrupted, abort immediately
if (status === 'interrupted') {
  return ABORT_STEP;
}

// REJECT - ループの存在を言い換えただけ
// Check transitions in order
for (const transition of step.transitions) {

// REJECT - 関数名の繰り返し
/** Check if status matches transition condition. */
export function matchesCondition(status: Status, condition: TransitionCondition): boolean {

// OK - 設計判断の理由（Why）
// ユーザー中断はピース定義のトランジションより優先する
if (status === 'interrupted') {
  return ABORT_STEP;
}

// OK - 一見不自然な挙動の理由
// stay はループを引き起こす可能性があるが、ユーザーが明示的に指定した場合のみ使われる
return step.name;
```

**状態の直接変更の検出基準**

配列やオブジェクトの直接変更（ミューテーション）を検出する。

```typescript
// REJECT - 配列の直接変更
const steps: Step[] = getSteps();
steps.push(newStep);           // 元の配列を破壊
steps.splice(index, 1);       // 元の配列を破壊
steps[0].status = 'done';     // ネストされたオブジェクトも直接変更

// OK - イミュータブルな操作
const withNew = [...steps, newStep];
const without = steps.filter((_, i) => i !== index);
const updated = steps.map((s, i) =>
  i === 0 ? { ...s, status: 'done' } : s
);

// REJECT - オブジェクトの直接変更
function updateConfig(config: Config) {
  config.logLevel = 'debug';   // 引数を直接変更
  config.steps.push(newStep);  // ネストも直接変更
  return config;
}

// OK - 新しいオブジェクトを返す
function updateConfig(config: Config): Config {
  return {
    ...config,
    logLevel: 'debug',
    steps: [...config.steps, newStep],
  };
}
```

## セキュリティ（基本チェック）

- インジェクション対策（SQL, コマンド, XSS）
- ユーザー入力の検証
- 機密情報のハードコーディング

## テスタビリティ

- 依存性注入が可能な設計か
- モック可能か
- テストが書かれているか

## アンチパターン検出

以下のパターンを見つけたら REJECT:

| アンチパターン | 問題 |
|---------------|------|
| God Class/Component | 1つのクラスが多くの責務を持っている |
| Feature Envy | 他モジュールのデータを頻繁に参照している |
| Shotgun Surgery | 1つの変更が複数ファイルに波及する構造 |
| 過度な汎用化 | 今使わないバリアントや拡張ポイント |
| 隠れた依存 | 子コンポーネントが暗黙的にAPIを呼ぶ等 |
| 非イディオマティック | 言語・FWの作法を無視した独自実装 |

## 抽象化レベルの評価

**条件分岐の肥大化検出**

| パターン | 判定 |
|---------|------|
| 同じif-elseパターンが3箇所以上 | ポリモーフィズムで抽象化 → REJECT |
| switch/caseが5分岐以上 | Strategy/Mapパターンを検討 |
| フラグ引数で挙動を変える | 別関数に分割 → REJECT |
| 型による分岐（instanceof/typeof） | ポリモーフィズムに置換 → REJECT |
| ネストした条件分岐（3段以上） | 早期リターンまたは抽出 → REJECT |

**抽象度の不一致検出**

| パターン | 問題 | 修正案 |
|---------|------|--------|
| 高レベル処理の中に低レベル詳細 | 読みにくい | 詳細を関数に抽出 |
| 1関数内で抽象度が混在 | 認知負荷 | 同じ粒度に揃える |
| ビジネスロジックにDB操作が混在 | 責務違反 | Repository層に分離 |
| 設定値と処理ロジックが混在 | 変更困難 | 設定を外部化 |

**良い抽象化の例**

```typescript
// 条件分岐の肥大化
function process(type: string) {
  if (type === 'A') { /* 処理A */ }
  else if (type === 'B') { /* 処理B */ }
  else if (type === 'C') { /* 処理C */ }
  // ...続く
}

// Mapパターンで抽象化
const processors: Record<string, () => void> = {
  A: processA,
  B: processB,
  C: processC,
};
function process(type: string) {
  processors[type]?.();
}
```

```typescript
// 抽象度の混在
function createUser(data: UserData) {
  // 高レベル: ビジネスロジック
  validateUser(data);
  // 低レベル: DB操作の詳細
  const conn = await pool.getConnection();
  await conn.query('INSERT INTO users...');
  conn.release();
}

// 抽象度を揃える
function createUser(data: UserData) {
  validateUser(data);
  await userRepository.save(data);  // 詳細は隠蔽
}
```

## その場しのぎの検出

「とりあえず動かす」ための妥協を見逃さない。

| パターン | 例 |
|---------|-----|
| 不要なパッケージ追加 | 動かすためだけに入れた謎のライブラリ |
| テストの削除・スキップ | `@Disabled`、`.skip()`、コメントアウト |
| 空実装・スタブ放置 | `return null`、`// TODO: implement`、`pass` |
| モックデータの本番混入 | ハードコードされたダミーデータ |
| エラー握りつぶし | 空の `catch {}`、`rescue nil` |
| マジックナンバー | 説明なしの `if (status == 3)` |

## TODOコメントの厳格な禁止

「将来やる」は決してやらない。今やらないことは永遠にやらない。

TODOコメントは即REJECT。

```kotlin
// REJECT - 将来を見越したTODO
// TODO: 施設IDによる認可チェックを追加
fun deleteCustomHoliday(@PathVariable id: String) {
    deleteCustomHolidayInputPort.execute(input)
}

// APPROVE - 今実装する
fun deleteCustomHoliday(@PathVariable id: String) {
    val currentUserFacilityId = getCurrentUserFacilityId()
    val holiday = findHolidayById(id)
    require(holiday.facilityId == currentUserFacilityId) {
        "Cannot delete holiday from another facility"
    }
    deleteCustomHolidayInputPort.execute(input)
}
```

TODOが許容される唯一のケース:

| 条件 | 例 | 判定 |
|------|-----|------|
| 外部依存で今は実装不可 + Issue化済み | `// TODO(#123): APIキー取得後に実装` | 許容 |
| 技術的制約で回避不可 + Issue化済み | `// TODO(#456): ライブラリバグ修正待ち` | 許容 |
| 「将来実装」「後で追加」 | `// TODO: バリデーション追加` | REJECT |
| 「時間がないので」 | `// TODO: リファクタリング` | REJECT |

正しい対処:
- 今必要 → 今実装する
- 今不要 → コードを削除する
- 外部要因で不可 → Issue化してチケット番号をコメントに入れる

## DRY違反の検出

基本的に重複は排除する。本質的に同じロジックであり、まとめるべきと判断したら DRY にする。回数で機械的に判断しない。

| パターン | 判定 |
|---------|------|
| 本質的に同じロジックの重複 | REJECT - 関数/メソッドに抽出 |
| 同じバリデーションの重複 | REJECT - バリデーター関数に抽出 |
| 本質的に同じ構造のコンポーネント | REJECT - 共通コンポーネント化 |
| コピペで派生したコード | REJECT - パラメータ化または抽象化 |

DRY にしないケース:
- ドメインが異なる重複は抽象化しない（例: 顧客用バリデーションと管理者用バリデーションは別物）
- 表面的に似ているが、変更理由が異なるコードは別物として扱う

## 仕様準拠の検証

変更が、プロジェクトの文書化された仕様に準拠しているか検証する。

検証対象:

| 対象 | 確認内容 |
|------|---------|
| CLAUDE.md / README.md | スキーマ定義、設計原則、制約に従っているか |
| 型定義・Zodスキーマ | 新しいフィールドがスキーマに反映されているか |
| YAML/JSON設定ファイル | 文書化されたフォーマットに従っているか |

具体的なチェック:

1. 設定ファイル（YAML等）を変更・追加した場合:
   - CLAUDE.md等に記載されたスキーマ定義と突合する
   - 無視されるフィールドや無効なフィールドが含まれていないか
   - 必須フィールドが欠落していないか

2. 型定義やインターフェースを変更した場合:
   - ドキュメントのスキーマ説明が更新されているか
   - 既存の設定ファイルが新しいスキーマと整合するか

このパターンを見つけたら REJECT:

| パターン | 問題 |
|---------|------|
| 仕様に存在しないフィールドの使用 | 無視されるか予期しない動作 |
| 仕様上無効な値の設定 | 実行時エラーまたは無視される |
| 文書化された制約への違反 | 設計意図に反する |

## 呼び出しチェーン検証

新しいパラメータ・フィールドが追加された場合、変更ファイル内だけでなく呼び出し元も検証する。

検証手順:
1. 新しいオプショナルパラメータや interface フィールドを見つけたら、`Grep` で全呼び出し元を検索
2. 全呼び出し元が新しいパラメータを渡しているか確認
3. フォールバック値（`?? default`）がある場合、フォールバックが使われるケースが意図通りか確認

危険パターン:

| パターン | 問題 | 検出方法 |
|---------|------|---------|
| `options.xxx ?? fallback` で全呼び出し元が `xxx` を省略 | 機能が実装されているのに常にフォールバック | grep で呼び出し元を確認 |
| テストがモックで直接値をセット | 実際の呼び出しチェーンを経由しない | テストの構築方法を確認 |
| `executeXxx()` が内部で使う `options` を引数で受け取らない | 上位から値を渡す口がない | 関数シグネチャを確認 |

```typescript
// 配線漏れ: projectCwd を受け取る口がない
export async function executePiece(config, cwd, task) {
  const engine = new PieceEngine(config, cwd, task);  // options なし
}

// 配線済み: projectCwd を渡せる
export async function executePiece(config, cwd, task, options?) {
  const engine = new PieceEngine(config, cwd, task, options);
}
```

呼び出し元の制約による論理的デッドコード:

呼び出しチェーンの検証は「配線漏れ」だけでなく、逆方向——呼び出し元が既に保証している条件に対する不要な防御コード——にも適用する。

| パターン | 問題 | 検出方法 |
|---------|------|---------|
| 呼び出し元がTTY必須なのに関数内でTTYチェック | 到達しない分岐が残る | grep で全呼び出し元の前提条件を確認 |
| 呼び出し元がnullチェック済みなのに再度nullガード | 冗長な防御 | 呼び出し元の制約を追跡 |
| 呼び出し元が型で制約しているのにランタイムチェック | 型安全を信頼していない | TypeScriptの型制約を確認 |

検証手順:
1. 防御的な条件分岐（TTYチェック、nullガード等）を見つけたら、grep で全呼び出し元を確認
2. 全呼び出し元がその条件を既に保証しているなら、防御は不要 → REJECT
3. 一部の呼び出し元が保証していない場合は、防御を残す

## 品質特性

| 特性 | 確認観点 |
|------|---------|
| Scalability | 負荷増加に対応できる設計か |
| Maintainability | 変更・修正が容易か |
| Observability | ログ・監視が可能な設計か |

## 大局観

細かい「クリーンコード」の指摘に終始しない。

確認すべきこと:
- このコードは将来どう変化するか
- スケーリングの必要性は考慮されているか
- 技術的負債を生んでいないか
- ビジネス要件と整合しているか
- 命名がドメインと一貫しているか

## 変更スコープの評価

変更スコープを確認し、レポートに記載する（ブロッキングではない）。

| スコープサイズ | 変更行数 | 対応 |
|---------------|---------|------|
| Small | 〜200行 | そのままレビュー |
| Medium | 200-500行 | そのままレビュー |
| Large | 500行以上 | レビューは継続。分割可能か提案を付記 |

大きな変更が必要なタスクもある。行数だけでREJECTしない。

確認すること:
- 変更が論理的にまとまっているか（無関係な変更が混在していないか）
- Coderのスコープ宣言と実際の変更が一致しているか

提案として記載すること（ブロッキングではない）:
- 分割可能な場合は分割案を提示
