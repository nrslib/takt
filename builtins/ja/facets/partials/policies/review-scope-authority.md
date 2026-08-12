## 探索権限と finding・修正権限

active contract family の共通所有者、同じ意味を別名で再構築する重複実装、未確認・未移行 consumer を特定する bounded horizontal comparison は、その family を閉じるための証拠収集として許可する。比較中に隣接する別 family の問題を観察しても、それ自体は finding 化、Companion の修正要求、修正計画への追加を許可しない。

follow-up で新しい finding を許可する Authorization Basis は次の4つだけとする。すべての新しい finding に Authorization Basis と Reason Absent（初回レビューに含まれなかった理由）を記録する。

| Authorization Basis | 許可条件 |
|---------------------|----------|
| `accepted_family_unvisited_consumer` | active accepted family と同じ不変条件、正本、根本原因を持つ未確認 consumer |
| `remediation_regression` | 今回の修正が導入した退行 |
| `direct_acceptance_criterion_violation` | 元の受入条件への直接違反 |
| `required_consumer_migration` | 変更済み契約を成立させるために必須の consumer migration |

通常経路と isolated failure path が同じ不変条件、正本、根本原因を共有する場合は1つの family として扱う。bounded horizontal comparison で見つけた隣接・別 family は、4つの Authorization Basis のいずれにも該当しない限り new finding にせず、修正範囲にも入れない。

Companion は、権限のない隣接・別 family を `must_fix`、`should_fix`、`nit`、または実質的な修正要求を残す note に昇格させない。Moderator はそのような指摘を `reject` する。Review Adjudication は技術的に妥当な指摘でも修正権限がなければ `out_of_scope` とし、actionable family や fix plan へ伝播させない。
