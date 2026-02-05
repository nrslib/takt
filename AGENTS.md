# Repository Guidelines
このドキュメントは、このリポジトリに貢献するための実務的な指針をまとめたものです。短く具体的な説明と例で、作業の迷いを減らします。

## Project Structure & Module Organization
- 主要ソースは `src/` にあり、エントリポイントは `src/index.ts`、CLI は `src/app/cli/index.ts` です。
- テストは `src/__tests__/` に置き、対象が明確になる名前を付けます（例: `client.test.ts`）。
- ビルド成果物は `dist/`、実行スクリプトは `bin/`、静的リソースは `resources/`、ドキュメントは `docs/` で管理します。
- 実行時の設定やキャッシュは `~/.takt/`、プロジェクト固有の設定は `.takt/` を参照します。

## Build, Test, and Development Commands
- `npm run build`: TypeScript をコンパイルして `dist/` を生成します。
- `npm run watch`: ソース変更を監視しながら再ビルドします。
- `npm run lint`: ESLint で `src/` を解析します。
- `npm run test`: Vitest で全テストを実行します。
- `npm run test:watch`: テストをウォッチ実行します。
- `npx vitest run src/__tests__/client.test.ts`: 単体テストを個別実行する例です。

## Coding Style & Naming Conventions
- TypeScript + strict を前提に、null 安全と可読性を優先します。
- ESM 形式のため、`import` の拡張子は `.js` に固定してください。
- 命名は camelCase（関数・変数）と PascalCase（クラス）を採用します。
- 共有型は `src/types/` に整理し、既存の命名パターンに合わせます。
- ESLint と Prettier の規約に従い、修正後は `npm run lint` を実行します。

## Testing Guidelines
- テストフレームワークは Vitest（`vitest.config.ts`）です。
- 新規機能や修正には関連テストを追加します。
- ファイル名は `<対象>.test.ts` または `<対象>.spec.ts` を使用します。
- 依存が重い箇所はモックやスタブで状態を分離します。

## Commit & Pull Request Guidelines
- コミットメッセージは短い要約が中心で、日本語・英語どちらも使われています。
- `fix:`, `hotfix:` などのプレフィックスや、`#32` のような Issue 参照が見られます。必要に応じて付けてください。
- バージョン更新や変更履歴の更新は明示的なメッセージで行います（例: `0.5.1`, `update CHANGELOG`）。
- PR には変更概要、テスト結果、関連 Issue を記載し、小さく分割してレビュー負荷を抑えます。UI/ログ変更がある場合はスクリーンショットやログを添付します。

## Security & Configuration Tips
- 脆弱性は公開 Issue ではなくメンテナへ直接報告します。
- `.takt/logs/` など機密情報を含む可能性のあるファイルは共有しないでください。
- `~/.takt/config.yaml` の `trusted` ディレクトリは最小限にし、不要なパスは登録しないでください。
- 新しいピースを追加する場合は `~/.takt/pieces/` の既存スキーマに合わせます。
