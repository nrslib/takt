# ユニットテスト知識

## テストダブルの使い分け

テストダブルは目的に応じて使い分ける。過剰なモックはテストの信頼性を下げる。

| 種類 | 目的 | 使用場面 |
|------|------|---------|
| Stub | 固定値を返す | 外部依存の出力を制御したい |
| Mock | 呼び出しを検証する | メソッド呼び出しの有無・引数を確認したい |
| Spy | 実装を残しつつ呼び出しを記録 | 副作用の検証をしたい |
| Fake | 簡易的な実装 | インメモリDBなど軽量な代替が必要 |

### モック粒度の判断

- テスト対象の直接の依存のみモックする（間接依存はモックしない）
- 「モックが多すぎる」はテスト対象の設計の問題を示唆する
- 純粋関数は依存がないのでモック不要

```typescript
// NG - 内部実装をモック（振る舞いではなく実装を検証している）
vi.spyOn(service, 'privateMethod')
service.execute()
expect(service.privateMethod).toHaveBeenCalled()

// OK - 外部依存をモックし、振る舞いを検証
const repository = { findById: vi.fn().mockResolvedValue(user) }
const service = new UserService(repository)
const result = await service.getUser('id')
expect(result).toEqual(user)
```

## 境界値分析

境界値と同値分割はユニットテストの基本手法。

| 手法 | 内容 |
|------|------|
| 同値分割 | 入力を等価なグループに分け、各グループから1つずつテスト |
| 境界値分析 | 同値クラスの境界でテスト（境界、境界±1） |

```typescript
// NG - 正常系のみ
test('validates age', () => {
  expect(validateAge(25)).toBe(true)
})

// OK - 境界値を含む
test('validates age at boundaries', () => {
  expect(validateAge(0)).toBe(true)    // 下限
  expect(validateAge(-1)).toBe(false)  // 下限-1
  expect(validateAge(150)).toBe(true)  // 上限
  expect(validateAge(151)).toBe(false) // 上限+1
})
```

## 振る舞い保証

ユニットテストは設定値や内部状態のスナップショットだけでなく、公開された契約が期待どおりに振る舞うことを検証する。拒否、許可、隔離、解放のような境界変更は、主要な成功/失敗ケースを deterministic に確認する。

| 基準 | 判定 |
|------|------|
| 期待する戻り値・例外・副作用が直接検証されている | OK |
| 境界変更の成功/失敗、許可/拒否の両側が検証されている | OK |
| 設定値や最後の内部状態だけを確認している | REJECT |
| 外部環境がないと主要な境界条件を再現できない | Fake や Stub による deterministic test を検討 |

## テストフィクスチャ設計

テストデータはファクトリ関数で管理する。

- ファクトリ関数で必要最小限のフィクスチャを生成する
- テストに無関係なフィールドはデフォルト値で埋める
- 共有フィクスチャを変更して使い回さない（テスト間の独立性を保つ）

```typescript
// NG - 全フィールドを毎回定義
const user = { id: '1', name: 'test', email: 'test@example.com', role: 'admin', createdAt: new Date() }

// OK - ファクトリ関数で必要最小限
const createUser = (overrides: Partial<User> = {}): User => ({
  id: 'test-id',
  name: 'test-user',
  email: 'test@example.com',
  role: 'user',
  ...overrides,
})

test('admin can delete', () => {
  const admin = createUser({ role: 'admin' })
  // テストに関係するフィールドだけ明示
})
```

## テスト対象の分離

テスト容易性は設計品質の指標。テストしにくいコードは依存が密結合している。

### 依存注入パターン

| パターン | 使用場面 |
|---------|---------|
| コンストラクタ注入 | クラスベースの依存分離 |
| 関数引数 | 関数の依存を引数で受け取る |
| モジュール差し替え | テスト時にモジュール全体を差し替える |

```typescript
// NG - 直接依存を生成（テストでモック不可）
class OrderService {
  private repo = new OrderRepository()
  async create(order: Order) { return this.repo.save(order) }
}

// OK - コンストラクタ注入（テストでモック可能）
class OrderService {
  constructor(private readonly repo: OrderRepository) {}
  async create(order: Order) { return this.repo.save(order) }
}
```
