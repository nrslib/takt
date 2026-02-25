# Terraform AWS 知識

## モジュール設計

モジュールはドメイン（ネットワーク、データベース、アプリケーション層）単位で分割する。汎用ユーティリティモジュールは作らない。

| 基準 | 判定 |
|------|------|
| ドメイン単位のモジュール分割 | OK |
| 汎用 "utils" モジュール | REJECT |
| 1モジュールに無関係なリソースが混在 | REJECT |
| モジュール間の暗黙的依存 | REJECT（出力→入力で明示的に接続） |

### モジュール間の依存

モジュール間の依存は出力→入力で明示的に渡す。暗黙的な参照（`data` ソースで他モジュールのリソースを引く）は避ける。

```hcl
# OK - 明示的な依存
module "database" {
  source     = "../../modules/database"
  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.private_subnet_ids
}

# NG - 暗黙的な依存
module "database" {
  source = "../../modules/database"
  # vpc_id を渡さず、module 内で data "aws_vpc" で引いている
}
```

### 識別変数のパススルー

環境名・サービス名などの識別変数は、ルートモジュールから子モジュールへ明示的に渡す。グローバル変数やハードコードに頼らない。

```hcl
# OK - 明示的なパススルー
module "database" {
  environment      = var.environment
  service          = var.service
  application_name = var.application_name
}
```

## リソース命名規約

`locals` で `name_prefix` を計算し、全リソースに一貫して適用する。リソース固有のサフィックスを付加する。

| 基準 | 判定 |
|------|------|
| `name_prefix` パターンで統一命名 | OK |
| 各リソースでバラバラに命名 | REJECT |
| AWS 文字数制限を超える名前 | REJECT |
| タグ名が PascalCase でない | 警告 |

```hcl
# OK - name_prefix で統一
locals {
  name_prefix = "${var.environment}-${var.service}-${var.application_name}"
}

resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"
}

# NG - 各リソースでバラバラに命名
resource "aws_ecs_cluster" "main" {
  name = "${var.environment}-app-cluster"
}
```

### 文字数制限への対応

AWS サービスには名前の文字数制限がある。制限に近い場合は短縮形を使う。

| サービス | 制限 | 例 |
|---------|------|-----|
| Target Group | 32文字 | `${var.environment}-${var.service}-backend-tg` |
| Lambda 関数 | 64文字 | フルプレフィックス可 |
| S3 バケット | 63文字 | フルプレフィックス可 |

## タグ戦略

provider の `default_tags` で共通タグを一括設定する。個別リソースでの重複タグ付けは不要。

| 基準 | 判定 |
|------|------|
| provider `default_tags` で一括設定 | OK |
| 個別リソースで `default_tags` と同じタグを重複設定 | 警告 |
| 個別リソースで `Name` タグのみ追加 | OK |

```hcl
# OK - provider で一括、個別は Name のみ
provider "aws" {
  default_tags {
    tags = {
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

resource "aws_instance" "main" {
  tags = {
    Name = "${local.name_prefix}-instance"
  }
}

# NG - default_tags と重複
resource "aws_instance" "main" {
  tags = {
    Environment = var.environment
    ManagedBy   = "Terraform"
    Name        = "${local.name_prefix}-instance"
  }
}
```

## ファイル構成パターン

### 環境ディレクトリ構造

環境ごとにディレクトリを分離し、各環境が独立した状態管理を持つ。

```
environments/
├── production/
│   ├── terraform.tf       # バージョン制約
│   ├── providers.tf       # プロバイダ設定（default_tags）
│   ├── backend.tf         # S3 バックエンド
│   ├── variables.tf       # 環境変数
│   ├── main.tf            # モジュール呼び出し
│   └── outputs.tf         # 出力
└── staging/
    └── ...
```

### モジュール内ファイル構成

| ファイル | 内容 |
|---------|------|
| `main.tf` | `locals`、`data` ソースのみ |
| `variables.tf` | 入力変数定義のみ（リソースなし） |
| `outputs.tf` | 出力定義のみ（リソースなし） |
| `{resource_type}.tf` | リソースカテゴリごとに1ファイル |
| `templates/` | user_data スクリプト等のテンプレート |

## セキュリティベストプラクティス

### EC2 インスタンスセキュリティ

| 設定 | 推奨値 | 理由 |
|------|--------|------|
| `http_tokens` | `"required"` | IMDSv2 強制（SSRF 防止） |
| `http_put_response_hop_limit` | `1` | コンテナエスケープ防止 |
| `root_block_device.encrypted` | `true` | 保存データ暗号化 |

### S3 バケットセキュリティ

パブリックアクセスは4項目すべてブロックする。CloudFront 経由の場合は OAC（Origin Access Control）を使用する。

```hcl
# OK - 完全ブロック
resource "aws_s3_bucket_public_access_block" "this" {
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

### IAM 設計

| パターン | 推奨 |
|---------|------|
| 用途別ロール分離 | 実行ロール（ECS Agent 用）とタスクロール（アプリ用）を分ける |
| CI/CD 認証 | OIDC フェデレーション（長期認証情報を使わない） |
| ポリシースコープ | リソース ARN を明示的に指定（`"*"` を避ける） |

### 機密情報管理

| 方法 | 推奨度 |
|------|--------|
| SSM Parameter Store（SecureString） | 推奨 |
| Secrets Manager | 推奨（ローテーション必要時） |
| `.tfvars` に直接記載 | 条件付きOK（gitignore 必須） |
| `.tf` ファイルにハードコード | REJECT |

SSM Parameter の初期値はプレースホルダーにし、`lifecycle { ignore_changes = [value] }` で Terraform 管理外にする。

## コスト最適化パターン

コスト影響のある選択にはインラインコメントでトレードオフを文書化する。

| 選択 | コスト効果 | トレードオフ |
|------|-----------|------------|
| NAT Instance vs NAT Gateway | NAT Instance は月額 ~$3-4 vs Gateway ~$32 | 可用性・スループットが劣る |
| パブリックサブネット配置 | VPC Endpoint 不要 | ネットワーク分離が弱まる |
| EC2 + EBS vs RDS | EC2 は月額 ~$15-20 vs RDS ~$50+ | 運用負荷が増える |

```hcl
# OK - トレードオフを文書化
# NAT Gateway の代わりに t3.nano を使用（約 $3-4/月 vs $32/月）
# トレードオフ: 可用性は単一AZ、スループット上限あり
resource "aws_instance" "nat" {
  instance_type = "t3.nano"
}
```

## Lifecycle ルールの使い分け

| ルール | 用途 | 適用対象 |
|--------|------|---------|
| `prevent_destroy` | 誤削除防止 | データベース、EBS ボリューム |
| `ignore_changes` | 外部変更を許容 | `desired_count`（Auto Scaling）、SSM の `value` |
| `create_before_destroy` | ダウンタイム防止 | ロードバランサー、セキュリティグループ |

```hcl
# OK - データベースの誤削除防止
resource "aws_instance" "database" {
  lifecycle {
    prevent_destroy = true
  }
}

# OK - Auto Scaling の desired_count を Terraform 管理外にする
resource "aws_ecs_service" "main" {
  lifecycle {
    ignore_changes = [desired_count]
  }
}
```

## バージョン管理

| 設定 | 推奨 |
|------|------|
| `required_version` | `">= 1.5.0"` 以上（`default_tags` サポート） |
| プロバイダバージョン | `~>` でマイナーバージョン固定（例: `~> 5.80`） |
| 状態ロック | `use_lockfile = true` 必須 |
