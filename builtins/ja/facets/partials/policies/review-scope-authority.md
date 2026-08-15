## 探索権限と finding・修正権限

contract family の同一性は、有効な role instruction に記載された定義を使い、この権限ポリシーでは定義し直さない。名前、型、近接性だけを、family をまとめる根拠にも分ける根拠にもしない。

active contract family の共通所有者、同じ意味を別名で再構築する重複実装、未確認・未移行 consumer を特定する bounded horizontal comparison は、その family を閉じるための証拠収集として許可する。比較中に隣接する別 family の問題を観察しても、それ自体は finding 化、Companion の修正要求、修正計画への追加を許可しない。

## Role ごとの権限

| Role | 許可範囲 | 禁止範囲 |
|------|----------|----------|
| Initial review | 提示された changed family の全経路を初回探索し、確認した欠陥を finding 化 | changed family と identity が異なる既存問題 |
| Follow-up review | accepted family の未確認 consumer、必須 migration、修正退行を確認 | 一般探索の再開、新しい隣接 family |
| Review adjudication | 提出済み candidate の妥当性と同一 family の境界を確認 | 一般初回探索、candidate のない新規 finding |
| Final preservation | 宣言済み actionable family の未移行、旧経路、片側更新、修正退行を merge blocker として確認 | 新しい family の発見・追加 |
| Companion | 提供された cumulative diff と context 内で active family の早期候補を報告 | 隠れた repository 経路を確認済みと主張、別 family の修正要求 |
| Companion Moderator | 提出済み Companion evidence を accept、merge、downgrade、reject | early scan、repository 探索、新しい finding、family 完了保証 |

follow-up で新しい finding を許可する Authorization Basis は次の4つだけとする。すべての新しい finding に Authorization Basis と Reason Absent（初回レビューに含まれなかった理由）を記録する。

| Authorization Basis | 許可条件 |
|---------------------|----------|
| `accepted_family_unvisited_consumer` | active accepted family と同じ不変条件、正本、根本原因を持つ未確認 consumer |
| `remediation_regression` | 今回の修正が導入した退行 |
| `direct_acceptance_criterion_violation` | 元の受入条件への直接違反 |
| `required_consumer_migration` | 変更済み契約を成立させるために必須の consumer migration |

通常経路と isolated failure path が同じ不変条件、正本、根本原因を共有する場合は1つの family として扱う。bounded horizontal comparison で見つけた隣接・別 family は、4つの Authorization Basis のいずれにも該当しない限り new finding にせず、修正範囲にも入れない。`direct_acceptance_criterion_violation` も、既に提示された acceptance contract family と identity を共有する場合に限る。新しい owner または root cause を必要とする問題は final/follow-up で新しい family にしない。

Companion は、権限のない隣接・別 family を `must_fix`、`should_fix`、`nit`、または実質的な修正要求を残す note に昇格させない。Moderator はそのような指摘を `reject` する。Review Adjudication は技術的に妥当な指摘でも修正権限がなければ `out_of_scope` とし、actionable family や fix plan へ伝播させない。

## Review mode

caller が渡す mode の domain は厳密に `initial | follow_up | unspecified` とする。大小文字違い、別表記、空文字、非文字列を暗黙に正規化しない。

explicit な `initial` または `follow_up` はそのまま使う。`unspecified` または mode absent では、直接実行される reviewer step の iteration が `1` なら `initial`、integer `2` 以上なら `follow_up` とする。不正な mode、または fallback に必要な iteration が未展開、非整数、`1` 未満なら `mode_unknown` とする。

`mode_unknown` では follow-up と同じ権限上限を適用し、accepted family の閉鎖、必須 consumer migration、修正退行だけを確認する。一般初回探索、隣接 family の finding 化、initial coverage 完了を根拠にした APPROVE を禁止する。不正な mode または fallback 理由を evidence に記録する。
