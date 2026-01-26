# Repository Guidelines

## プロジェクト構成とモジュール整理
- 主要なソースは `src/`、CLI は `src/cli.ts`、公開 API は `src/index.ts` にある。
- テストは `src/__tests__/` に配置する。
- ビルド成果物は `dist/`、実行用スクリプトは `bin/`。
- 既定のリソースは `resources/`、ドキュメントは `docs/`。
- 実行時設定はユーザーディレクトリ `~/.takt/`、プロジェクト固有設定は `.takt/` に置く。

## ビルド・テスト・開発コマンド
```
npm run build       # TypeScript をコンパイルして dist/ を生成
npm run watch       # 変更監視ビルド
npm run test        # Vitest の全テスト実行
npm run test:watch  # Vitest のウォッチモード
npm run lint        # ESLint で静的解析
```
単体実行例: `npx vitest run src/__tests__/client.test.ts`

## コーディング規約と命名
- TypeScript の strict 設定を前提にする。
- ESM 形式のため、import の拡張子は `.js` を使う。
- 既存ファイルは ESLint ルールに従い、読みやすさ優先で簡潔に書く。
- 変更対象の命名や構成は既存パターンに合わせる。

## テスト指針
- テストフレームワークは Vitest。
- 追加・修正は関連テストの追加を推奨する。
- テストファイルは `src/__tests__/` に置き、内容が分かる名前を付ける。

## コミットとプルリク
- 直近の履歴は短い要約の一行コミットが中心（日本語・英語混在）。
- 変更内容が分かる簡潔な件名を推奨。
- PR は小さく集中した変更を基本とし、必要ならテストとドキュメントを更新。
- 事前に Issue を立てて相談する方針。

## セキュリティと設定の注意
- 脆弱性は公開 Issue ではなく、メンテナへ非公開で報告する。
- `.takt/logs/` には機密情報が残る可能性があるため取り扱いに注意。
- `~/.takt/config.yaml` の trusted ディレクトリは必要最小限に絞る。

## エージェント向け補足
- ワークフローは `~/.takt/workflows/` の YAML を読み込む。
- 既存の遷移条件やスキーマは安易に拡張しない。
