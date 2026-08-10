# データ・機密情報セキュリティ知識

## 適用条件

機密情報、ログ、エラーレスポンス、暗号化を扱う変更に適用する。

## データ保護

**機密情報の露出**

- APIキー、シークレットのハードコーディング → 即REJECT
- ログへの機密情報出力 → REJECT
- エラーメッセージでの内部情報露出 → REJECT
- `.env` ファイルのコミット → REJECT

## ログとマスキング

機密情報がログやレスポンスに露出するのを防ぐ。

**ログに出力してはいけない情報:**
- パスワード、トークン、APIキー
- クレジットカード番号、個人識別番号
- セッションID、認証ヘッダの値
- 個人情報（メールアドレス、電話番号）のうち、デバッグ目的で不要なもの

**マスキングパターン:**

```typescript
// NG - パスワードがログに露出
logger.info('User login attempt', { email, password })

// OK - 機密フィールドを除外
logger.info('User login attempt', { email })
```

```kotlin
// NG - リクエスト全体をログ出力
logger.info("Request: {}", request)

// OK - 機密フィールドをマスク
logger.info("Request: userId={}, action={}", request.userId, request.action)
```

**構造化ログでのフィールドフィルタリング:**

ログ出力にオブジェクトを渡す場合、`toString()` や JSON シリアライズで機密フィールドが含まれないようにする。

```kotlin
// NG - data class の toString() がパスワードを含む
data class UserCredentials(val email: String, val password: String)

// OK - toString() をオーバーライドしてマスク
data class UserCredentials(val email: String, val password: String) {
    override fun toString(): String = "UserCredentials(email=$email, password=***)"
}
```

| 基準 | 判定 |
|------|------|
| ログ出力にパスワード・トークン・APIキーが含まれる | REJECT |
| エラーレスポンスにスタックトレースや内部パスが含まれる | REJECT |
| data class の toString() が機密フィールドを露出する | REJECT |
| ログレベルに関わらず機密情報が出力される可能性がある | REJECT |
| デバッグログに個人情報が含まれるが本番で無効化されている | 警告。設定ミスのリスクがある |

## 暗号化

- 弱い暗号アルゴリズムの使用 → REJECT
- 固定IV/Nonceの使用 → REJECT
- 暗号化キーのハードコーディング → 即REJECT
- HTTPSの未使用（本番環境） → REJECT

## エラーハンドリング

- スタックトレースの本番露出 → REJECT
- 詳細なエラーメッセージの露出 → REJECT
- エラーの握りつぶし（セキュリティイベント） → REJECT

## OWASP Top 10 チェックリスト

| カテゴリ | 確認事項 |
|---------|---------|
| A02 Cryptographic Failures | 暗号化、機密データ保護 |
| A09 Logging Failures | セキュリティログ |
