裁定結果は「修正対象あり」。

channel 正規化の欠陥には、安定した単一の family identity `FAM-channel-normalization` を使用します。この family 内では、Authorization Basis を別々に帰属できる2つのグループとして保持します。

- `CODE-NEW-channel-normalization-L2` は `direct_acceptance_criterion_violation` を根拠とする `actionable`。
- `ARCH-NEW-channel-normalization-L2` は同じ根拠 `direct_acceptance_criterion_violation` を持つ `duplicate`。transaction の提案は不要として退け、修正は共有 normalizer の局所変更に留めます。確認済みの根本欠陥は、実行 consumer が受理 channel の述語を独自に複製し、共有正規化の責務境界を迂回していることです。この DRY 違反と責務境界の欠陥を根本原因に保持し、受入条件では独自述語の除去を要求します。
- `CODE-NEW-worker-channel-retention-L2` は同じ family に属し、`remediation_regression` を根拠とする `actionable`。初回ラウンド後に remediation が worker 経路を作成したため、初回には存在しませんでした。

この family は、`local` と `cloud` を大文字小文字を区別せず前後空白を無視して受理し、レガシー別名を追加せずに不正値を拒否し、すべての実行経路に正規化済み値の保持を要求します。修正対象は `normalizeChannel` の利用と、確認済みの実行 consumer だけです。transaction、rollback、atomicity の要件は追加しません。

その他の提出済み finding はそれぞれ正確に1回記録し、修正対象 family の外に保持します。

- `ARCH-NEW-channel-type-error-L2`: 技術的には確認済みですが `overreach`。タスクは厳密なエラー class や message を約束していません。Authorization Basis と対象 family はなしです。
- `ARCH-NEW-build-label-dup-L1`: 技術的には確認済みですが `out_of_scope`。変更されていない build-label 契約に属します。Authorization Basis と対象 family はなしです。
- `TEST-NEW-readme-examples-L1`: `overreach`。網羅的なドキュメント例は要求されていません。Authorization Basis と対象 family はなしです。
- `SEC-NEW-secret-leak-L3`: `false_positive`。現在のエラーは raw input を補間していません。Authorization Basis と対象 family はなしです。
- `AI-NEW-windows-proof-L1`: `environment_unverified`。Windows の証跡はタスク要件ではなく、実装欠陥を立証しません。Authorization Basis と対象 family はなしです。

initial-review finding の「初回に含まれなかった理由」は該当なしです。`FAM-channel-normalization` の basis 別行のいずれかが未解消である限り、blocking を維持します。

次の再発台帳を `subworkflows/iteration-2--step-remediation--family-history/fix-verification.md` から変更せず引き継ぎます。

| 修正単位 | Family ID | 不変条件名 | 担当箇所 | 今回の検証回数 | 前回の検証回数 | 前回経路 | 今回経路 | 同一不変条件・再発判定 | 累積 `incomplete` 回数 | 別経路での再発確認 | 強制点候補 | 記録の完全性 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FP-CHANNEL-NORMALIZATION | FAM-channel-normalization | 受理した `local` と `cloud` の文字列を一度だけ正規化し、すべての実行経路で保持する。 | `src/channel.js` の `normalizeChannel` | 1 | なし | なし | `src/channel.js:1` の公開正規化境界 | 判定不能（初回） | 1 | 未確認 | 該当なし | 完全 |
