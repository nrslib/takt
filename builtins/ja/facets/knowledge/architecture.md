# アーキテクチャ知識

## 構造・設計

**ファイル分割**

ファイルは、同じ責務と変更理由を持つコードがまとまる単位にする。行数は内容を読み直すきっかけにはなるが、分割の根拠や品質の合否条件にはならない。責務が独立して変わる場合は分け、密接に協調して同じ理由で変わる小さな定義は同居できる。

**モジュール構成**

- 高凝集: 関連する機能がまとまっているか
- 低結合: モジュール間の依存が最小限か
- 循環依存がないか
- 適切なディレクトリ階層か

**操作の一覧性**

ドメイン上の操作や外部副作用は、目的と所有者が追える名前・境界を持つと理解しやすい。同じ契約を担う呼び出しが複数の場所で再構成されている場合は、共通の所有者へ集約する候補になる。一方、意図が明白な汎用 API の直接利用まで、一覧性だけを理由にラップする必要はない。

**パブリック API の公開範囲**

パブリック API が公開するのは、ドメインの操作に対応する関数・型のみ。インフラの実装詳細（特定プロバイダーの関数、内部パーサー等）を公開しない。

| 判定 | 基準 |
|------|------|
| REJECT | インフラ層の関数がパブリック API からエクスポートされている |
| REJECT | 内部実装の関数が外部から直接呼び出し可能になっている |
| OK | 外部消費者がドメインレベルの抽象のみを通じて対話する |

**関数設計**

- 1関数1責務になっているか
- 役割や変更理由が独立している処理は分離する
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

**プロトコル境界の例外変換**

HTTP、CLI、GraphQL、message consumer などの adapter は、内部例外を外部プロトコルの表現へ変換する境界である。endpoint や handler ごとに同じ try-catch / response 変換を散在させると、ステータス、エラー形状、ログ、認可失敗の扱いが不整合になりやすい。例外変換は adapter 境界の専用レイヤに集約し、真に横断的な変換だけを global handler に置く。

| 基準 | 判定 |
|------|------|
| endpoint / handler ごとに同じ例外から同じプロトコル表現への変換を実装している | REJECT |
| プロトコル表現への変換が application/domain 層に入っている | REJECT |
| 特定 API 固有の例外変換を全 API 共通の global handler に置いている | REJECT |
| adapter 境界の例外変換レイヤで、外部表現への変換を一元化している | OK |

## 境界での解決

設定、Option、provider、権限、パスのような値は、境界で解決してから内部へ渡す。メイン処理は「何が解決済みか」を前提に組み立て、各所で設定ソースを問い合わせない。

| 基準 | 判定 |
|------|------|
| 入口で `ExecutionContext` や `ResolvedOptions` のような解決済みオブジェクトを作る | OK |
| オーケストレーション層が解決済みの値だけを扱う | OK |
| 下位層が global/project/env を再読込して同じ値を再解決する | REJECT |
| 表示用と実行用で別々の解決関数を持つ | REJECT |
| 未解決の options を深い層まで運び、先で `??` 解決する | REJECT |

```typescript
// REJECT - 実行層が設定ソースを直接知っている
async function executeWorkflow(options) {
  const engine = new WorkflowEngine({
    provider: options.provider ?? globalConfig.provider,
  });
}

class AgentRunner {
  run(step, options) {
    const provider = options.provider ?? resolveProviderFromConfig();
    return getProvider(provider).call();
  }
}

// OK - 境界で解決し、内部は解決済み値を使う
async function executeWorkflow(options) {
  const context = resolveExecutionContext(options);
  const engine = new WorkflowEngine(context);
}

class AgentRunner {
  run(step, options) {
    return getProvider(options.resolvedProvider).call();
  }
}
```

### Tell, Don't Ask

下位層に設定ソースを問い合わせさせるのではなく、上位層が「これを使え」と解決済みの値を渡す。値の選択責務と実行責務を分離する。

| パターン | 判定 |
|---------|------|
| 上位層が `resolvedProvider` のような値を渡す | OK |
| 下位層が `options` を覗いて自前で解決する | REJECT |
| 実行オブジェクトが `setup(config)` 後は `run()` だけ公開する | OK |
| 実行中に `getGlobalConfig()` を呼んで分岐する | REJECT |

### 腐敗防止層

優先順位解決や外部設定形式の吸収は、境界の専用層に閉じ込める。内部モデルへは正規化済みの値だけを渡す。

| パターン | 判定 |
|---------|------|
| YAML/env/CLI 差分を resolver/adapter に閉じ込める | OK |
| ドメイン層が env 名や設定キー文字列を直接扱う | REJECT |
| 外部形式から内部形式への変換が1箇所に集約されている | OK |
| 同じ正規化ロジックが複数箇所にコピーされている | REJECT |

### 候補解決と値合成の分離

複数の候補から参照先を選ぶ処理と、選ばれた値を合成する処理は別の契約として扱う。探索順、上書き規則、参照種別を混ぜると、表示・検証・実行で別の結果になりやすい。

| 基準 | 判定 |
|------|------|
| 候補探索が first-match なのに、値合成の deep merge と混同して複数候補を暗黙に合成する | REJECT |
| 近いスコープの候補が遠いスコープの候補より後に探索される | REJECT |
| 参照文字列を「区切り文字を含むか」だけで分類し、特殊参照と明示パスを混同する | REJECT |
| 候補探索、参照種別の分類、値合成の責務が別関数として読める | OK |

```typescript
// REJECT - 参照種別と探索基準が1つの条件に混ざっている
const root = ref.includes('/') ? currentRoot : ownerRoot

// OK - 種別を先に分類し、種別ごとの探索契約を分ける
const kind = classifyReference(ref)
const root = resolveRootForReference(kind, resolvedPath)
```

### Raw入力の正規化

外部ファイルや設定から読む値は、構文上 valid でも期待する shape とは限らない。境界で unknown として受け、配列・record・scalar へ正規化してから内部処理へ渡す。

| 基準 | 判定 |
|------|------|
| parse 直後の unknown 値に配列メソッドやプロパティアクセスを直接行う | REJECT |
| 「存在する」だけでファイル種別やディレクトリ要件を満たしたと扱う | REJECT |
| unknown を境界で内部型へ正規化し、契約外shapeを無視・正規化・明示エラーのいずれかに固定する | OK |
| ファイルとディレクトリの要件を実体種別まで確認する | OK |

### フェーズ分離

入力、解釈、実行、出力を段階で分ける。反復処理は、できる限り「解釈済みの入力をまとめて受け取り、実行だけを繰り返す」構造にする。

| 基準 | 判定 |
|------|------|
| 入口で raw input を `Resolved*` 型へ変換してから本処理に渡す | OK |
| ループ本体が解決済みデータに対する実行だけを担う | OK |
| ループ内で毎回 config/env/option を解釈する | REJECT |
| 反復ごとに「入力取得→解釈→実行→出力」を1関数に詰め込む | REJECT |
| 最適化で逐次処理が必要でも、解釈フェーズを専用メソッドに隔離している | OK |

```typescript
// REJECT - 各反復が入力解釈まで担う
for (const item of items) {
  const resolved = resolveItem(item, rawOptions, config);
  const result = execute(resolved);
  output(result);
}

// OK - 先に解釈し、反復は実行だけ
const resolvedItems = items.map((item) => resolveItem(item, rawOptions, config));

for (const item of resolvedItems) {
  const result = execute(item);
  output(result);
}
```

逐次解釈が必要なケースでも、`nextRawInput()` と `resolveInput()` と `executeResolved()` の責務は分ける。性能要件でフェーズを近づけても、責務まで混ぜない。

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
| OK | 定数・マジックナンバーの算出根拠や内訳を説明している |
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
// ユーザー中断はワークフロー定義のトランジションより優先する
if (status === 'interrupted') {
  return ABORT_STEP;
}

// OK - 一見不自然な挙動の理由
// stay はループを引き起こす可能性があるが、ユーザーが明示的に指定した場合のみ使われる
return step.name;

// OK - 定数の算出根拠
// paddingTop + paddingBottom + button height
const footerHeight = 24 + 12 + 48;
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

**条件分岐と抽象化**

分岐の数や構文だけでは抽象化方式を決められない。同じ意味・契約・変更理由を持つ実装が2つ確認できた時点で、共通の所有者へ集約すべきか判断する。外部 I/O とドメイン、方針と仕組み、公開契約と内部実装のように既存の境界がある場合は、最初の実装でも境界を表す抽象化が有効である。将来のバリアントを予測した Strategy やポリモーフィズムは追加しない。

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

## 未完成コードの検出

未完成コードの判定基準はコーディングポリシーに従う。アーキテクチャレビューでは、TODO/FIXME、空実装、スタブが設計上必要な境界・認可・バリデーション・契約更新の代替になっていないかを見る。

Issue番号・外部制約・除去条件のない TODO/FIXME は REJECT。

```kotlin
// REJECT - 認可チェックをTODOで先送り
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

TODO/FIXMEが許容されるケース:

| 条件 | 例 | 判定 |
|------|-----|------|
| 外部依存で今は実装不可 + Issue化済み + 除去条件あり | `// TODO(#123): APIキー取得後に実装` | 許容 |
| 技術的制約で回避不可 + Issue化済み + 除去条件あり | `// TODO(#456): ライブラリバグ修正待ち` | 許容 |
| 「将来実装」「後で追加」 | `// TODO: バリデーション追加` | REJECT |
| 「時間がないので」 | `// TODO: リファクタリング` | REJECT |

正しい対処:
- 今必要 → 今実装する
- 今不要 → コードを削除する
- 外部要因で不可 → Issue化してチケット番号をコメントに入れる

## DRY違反の検出

DRY はコード形状ではなく知識の重複を減らす原則である。同じ意味・契約・変更理由を持つ実装が2つ確認できたら、共通の所有者へ集約するか判断する。集約方法は関数、値オブジェクト、コンポーネント、ポリシーなど、その責務に最も自然な形を選ぶ。

DRY にしないケース:
- ドメインが異なる重複は抽象化しない（例: 顧客用バリデーションと管理者用バリデーションは別物）
- 表面的に似ているが、変更理由が異なるコードは別物として扱う

## 仕様準拠の検証

契約変更の整合性は有効な契約置換ポリシーに従う。アーキテクチャレビューでは、変更が文書化された仕様、型、スキーマ、設定形式と矛盾していないかを見る。

整合が必要になる条件:

| 変更 | 関係する契約 |
|------|---------|
| 設定ファイルの追加・変更 | 文書化された schema、必須フィールド、有効値 |
| 型・schema の追加・変更 | producer、consumer、利用者向け説明、変更対象外の有効な設定 |
| 設計制約に関わる変更 | その制約を定める一次仕様と実装境界 |

このパターンを見つけたら REJECT:

| パターン | 問題 |
|---------|------|
| 仕様に存在しないフィールドの使用 | 無視されるか予期しない動作 |
| 仕様上無効な値の設定 | 実行時エラーまたは無視される |
| 文書化された制約への違反 | 設計意図に反する |

## 呼び出しチェーン検証

契約変更の配線漏れはコーディングポリシーに従う。アーキテクチャレビューでは、新しいパラメータ・フィールドが変更ファイル内だけで完結しておらず、実際の呼び出し元・生成元・読み取り側まで届いているかを見る。

契約が呼び出しチェーンを横断する場合、定義だけでは成立しない。値を生成する入口、伝播する呼び出し元、読み取る消費者が同じ意味を共有し、フォールバックも契約上の省略可能性と一致する必要がある。

危険パターン:

| パターン | 問題 | 検出方法 |
|---------|------|---------|
| `options.xxx ?? fallback` で全呼び出し元が `xxx` を省略 | 機能が実装されているのに常にフォールバック | 呼び出し元を確認 |
| テストがモックで直接値をセット | 実際の呼び出しチェーンを経由しない | テストの構築方法を確認 |
| `executeXxx()` が内部で使う `options` を引数で受け取らない | 上位から値を渡す口がない | 関数シグネチャを確認 |

```typescript
// 配線漏れ: projectCwd を受け取る口がない
export async function executeWorkflow(config, cwd, task) {
  const engine = new WorkflowEngine(config, cwd, task);  // options なし
}

// 配線済み: projectCwd を渡せる
export async function executeWorkflow(config, cwd, task, options?) {
  const engine = new WorkflowEngine(config, cwd, task, options);
}
```

呼び出し元の制約による論理的デッドコード:

呼び出しチェーンの検証は「配線漏れ」だけでなく、逆方向——呼び出し元が既に保証している条件に対する不要な防御コード——にも適用する。

| パターン | 問題 | 検出方法 |
|---------|------|---------|
| 呼び出し元がTTY必須なのに関数内でTTYチェック | 到達しない分岐が残る | 全呼び出し元の前提条件を確認 |
| 呼び出し元がnullチェック済みなのに再度nullガード | 冗長な防御 | 呼び出し元の制約を追跡 |
| 呼び出し元が型で制約しているのにランタイムチェック | 型安全を信頼していない | TypeScriptの型制約を確認 |

防御条件の必要性は、到達可能な入口が保証する事前条件で決まる。すべての実在入口が同じ条件を保証するなら内部ガードは論理的に到達不能になり、保証しない入口があるなら境界防御として意味を持つ。

## 公開状態の不変性

モジュールが公開する共有状態（初期状態、シングルトン、設定オブジェクト）では、利用側の変更が別の利用者へ漏れないことが重要である。必要な保証は観測可能な分離であり、ファクトリ、防御的コピー、永続データ構造、freeze などは実装上の選択肢である。公開契約が方式まで定めない限り、再帰的 freeze や参照同一性そのものを必須にしない。

```typescript
// REJECT - 可変の公開初期状態。利用側が書き換えると全 replay の起点が汚染される
export const initialState: State = { count: 0, entries: {} };

// 選択肢 - freeze で保護（ネストも含めて）
export const initialState: State = Object.freeze({ count: 0, entries: Object.freeze({}) });

// 選択肢 - ファクトリで毎回新しいインスタンスを返す
export function createInitialState(): State {
  return { count: 0, entries: {} };
}
```

## 品質特性

| 特性 | 確認観点 |
|------|---------|
| Scalability | 負荷増加に対応できる設計か |
| Maintainability | 変更・修正が容易か |
| Observability | ログ・監視が可能な設計か |

## 大局観

細かい「クリーンコード」の指摘に終始しない。

品質特性は、要求、現在の負荷、既存の運用契約、または今回変更する境界から必要性を確認できる場合だけ設計条件になる。将来変わるかもしれない、規模が増えるかもしれないという予測だけでは、拡張点や追加レイヤーの根拠にならない。ドメイン命名と現在のビジネス契約の整合は、将来予測とは別に現在の意味契約として扱う。

## 変更スコープの評価

変更スコープは行数ではなく、要求・根本原因・同じ契約を持つ影響経路として論理的にまとまっているかで評価する。広い変更でも不可欠な場合があり、小さい変更でも無関係な編集は過剰である。

論理的なまとまりは、要求、根本原因、同じ契約、または実在する境界を共有することから説明できる。Coder のスコープ宣言は補助証跡であり、実際の変更との不一致がある場合も、要求と影響経路を正として評価する。
