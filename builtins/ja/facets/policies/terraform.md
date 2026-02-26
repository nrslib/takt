# Terraform ポリシー

安全性と保守性を最優先し、一貫した規約に従うインフラコードを書く。

## 原則

| 原則 | 基準 |
|------|------|
| Security by Default | セキュリティはデフォルトで厳格。緩和は明示的かつ理由付き |
| Fail Fast | 必須値にデフォルトを入れない。不足は即エラー |
| 命名一貫性 | `name_prefix` パターンで全リソースを統一命名 |
| 最小権限 | IAM は必要最小限のアクション・リソースに絞る |
| コスト意識 | トレードオフはコメントで文書化 |
| DRY | `locals` で共通値を計算。重複排除 |
| 1ファイル1関心事 | リソースカテゴリごとにファイル分割 |

## 変数宣言

| 基準 | 判定 |
|------|------|
| `type` なし | REJECT |
| `description` なし | REJECT |
| 機密値に `sensitive = true` なし | REJECT |
| 環境依存値にデフォルト設定 | REJECT |
| 定数的な値（ポート番号等）にデフォルト設定 | OK |

```hcl
# REJECT - type/description なし
variable "region" {}

# REJECT - 機密値に sensitive なし
variable "db_password" {
  type = string
}

# OK - 定数的な値にデフォルト
variable "container_port" {
  type        = number
  description = "Container port for the application"
  default     = 8080
}
```

## セキュリティ

| 基準 | 判定 |
|------|------|
| EC2 で IMDSv2 未強制（`http_tokens != "required"`） | REJECT |
| EBS/RDS 暗号化なし | REJECT |
| S3 パブリックアクセスブロックなし | REJECT |
| セキュリティグループで `0.0.0.0/0` への不要な開放 | REJECT |
| IAM ポリシーに `*` リソース（正当な理由なし） | REJECT |
| SSH 直接アクセス（SSM 代替可能な場合） | REJECT |
| 機密情報のハードコーディング | REJECT |
| `lifecycle { prevent_destroy = true }` が重要データに未設定 | 警告 |

## 命名規約

| 基準 | 判定 |
|------|------|
| `name_prefix` パターン未使用 | REJECT |
| リソース名に環境名が含まれない | REJECT |
| タグ名が PascalCase でない | 警告 |
| AWS 文字数制限を超える名前 | REJECT |

## ファイル構成

| 基準 | 判定 |
|------|------|
| `main.tf` にリソース定義が混在 | REJECT |
| `variables.tf` にリソースが定義されている | REJECT |
| 1ファイルに複数カテゴリのリソースが混在 | 警告 |
| 未使用の variable / output / data source | REJECT |

## タグ管理

| 基準 | 判定 |
|------|------|
| provider `default_tags` 未設定 | REJECT |
| `default_tags` と個別リソースでタグが重複 | 警告 |
| `ManagedBy = "Terraform"` タグなし | 警告 |

## コスト管理

| 基準 | 判定 |
|------|------|
| コスト影響のある選択にコメントなし | 警告 |
| 高コストリソース（NAT Gateway 等）に代替案の検討なし | 警告 |
