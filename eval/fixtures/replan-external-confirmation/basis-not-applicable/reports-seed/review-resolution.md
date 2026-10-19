# 最終検証結果
## 結果: BLOCKED
その他の要件は充足し、修正と現在のコード状態 c59484b65b031cf5bbaafef17c249e1123b5729eaf46cbd764d9d7953a697a37 の必要な環境内の検証は完了。コードの追加修正はない。
## 外部確認待ち（BLOCKED の場合）
| 問題ID | 未確認の受入条件 | 要求上の根拠 | この環境で完了した修正と検証（対象のコード状態を含む） | 確認先と方法 | 確定に必要な証拠 |
|--------|----------------|------------|------------------------------------------------------|------------|----------------|
| P-1 | 決済事業者の本番 webhook で受付と再送の処理結果を確認する | CONTRACT.md:4「署名付きの paid と refunded を既存の receive 経路へ渡し、受付結果を返す。」および environment.md:4「決済事業者の本番管理画面から署名付きイベントを送信し、同じイベントを再送すると、受信記録で受付結果と二重処理の有無を観測できる。」 | コード状態 c59484b65b031cf5bbaafef17c249e1123b5729eaf46cbd764d9d7953a697a37。署名検証、paid / refunded の受付・再送抑止の修正と現在版の node --test は完了・成功。検証: 完了。 | 決済連携の運用担当者が事業者の本番管理画面から署名付きイベントを送信し、同じイベントを再送する。本番送信権限と受信設備は運用担当者が管理し、この環境からアクセスできない | 対象コード状態とイベントIDに対応する本番受信記録、受付成功と二重処理なしの記録 |

## ローカル検証の記録
実行コマンド: node --test eval/fixtures/replan-external-confirmation/basis-not-applicable/app.test.mjs。exit 0。
```text
✔ paid event and replay (0.519959ms)
✔ invalid signature has no effect (0.096875ms)
✔ refund event and replay (0.043917ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 63.196167
```
