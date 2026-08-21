## 探索権限と finding・修正権限

contract family の同一性は、有効な role instruction に記載された定義を使い、この権限ポリシーでは定義し直さない。名前、型、近接性だけを、family をまとめる根拠にも分ける根拠にもしない。

active contract family の担当箇所、同じ意味を別名で再構築する重複実装、未確認・未移行 consumer を特定する bounded horizontal comparison は、その family を閉じるための証拠収集として許可する。比較中に隣接する別 family の問題を観察しても、それ自体は finding 化、Companion の修正要求、修正計画への追加を許可しない。

## Role ごとの権限

| Role | 許可範囲 | 禁止範囲 |
|------|----------|----------|
| Initial review | 提示された changed family の全経路を初回探索し、確認した欠陥を finding 化 | changed family と identity が異なる既存問題 |
| Follow-up review | accepted family の未確認 consumer、必須 migration、修正退行を確認 | 一般探索の再開、新しい隣接 family |
| Review adjudication | 提出済み candidate の妥当性と同一 family の境界を確認 | 一般初回探索、candidate のない新規 finding |
| Final preservation | 元要件が定義した accepted family または宣言済み actionable family の未移行、旧経路、片側更新、修正退行を merge blocker として確認 | 元要件にも既存裁定にもない新しい family の発見・追加 |
| Companion | 提供された cumulative diff と context 内で active family の早期候補を報告 | 隠れた repository 経路を確認済みと主張、別 family の修正要求 |
| Companion Moderator | 提出済み Companion evidence を accept、merge、downgrade、reject | early scan、repository 探索、新しい finding、family 完了保証 |

follow-up または Final preservation で新しい finding を許可する Authorization Basis は次の4つだけとする。すべての新しい finding に Authorization Basis と Reason Absent（初回レビューに含まれなかった理由）を記録する。Final preservation では、元要件が定義した accepted family または宣言済み actionable family を active accepted family として同じ決定順序を適用する。

| Authorization Basis | 許可条件 |
|---------------------|----------|
| `remediation_regression` | 今回の修正で新設・変更・公開・接続された実装または経路にある欠陥 |
| `required_consumer_migration` | 修正前から存在して今回の修正では変更・公開・接続されておらず、裁定・初回レビュー・修正計画が既に特定していた consumer の未実施 migration |
| `accepted_family_unvisited_consumer` | 修正前から存在して今回の修正では変更・公開・接続されておらず、active accepted family の初回走査と修正記録から漏れていた consumer |
| `direct_acceptance_criterion_violation` | 上記3分類の因果条件に該当せず、既に提示された元の受入条件へ直接違反する経路 |

各 new finding には主因となる Authorization Basis を1つだけ記録する。次の決定順序を最初に一致した条件で打ち切り、後の分類へ重ねない。

1. 今回の修正で対象実装を新設・変更した、または対象経路を新しく公開・接続した場合は `remediation_regression`
2. それ以外の変更されていない既存 consumer を、active accepted family の裁定、初回レビュー、または修正計画が既に特定し、必要な migration が未実施の場合は `required_consumer_migration`
3. それ以外の変更されていない既存 consumer が active accepted family と同じ不変条件、担当箇所、同じ原因で変更される理由を持つ一方、初回走査と修正記録から漏れていた場合は `accepted_family_unvisited_consumer`
4. それ以外で、既に提示された元の受入条件と identity を共有する直接違反は `direct_acceptance_criterion_violation`

修正を試みたが不完全だった consumer は、修正前に特定済みでも1番の `remediation_regression` とする。2番の `required_consumer_migration` は今回の修正で対象 consumer に手を付けていない場合だけに使う。修正差分・修正対象一覧・実コード・裁定成果物のいずれかでこの関係を確認し、名前や現在の family 所属だけで分類しない。他の関係は根拠または必要な移行として説明できるが、Authorization Basis 欄へ複数値を記録しない。

1つの候補 finding に、主因となる Authorization Basis が異なる複数の欠陥経路が含まれる場合は、同じ family、同じテストファイル、同じ修正案であっても finding を分ける。複数経路を1件へまとめたまま1つの Authorization Basis で代表させない。

通常経路と isolated failure path が同じ不変条件、担当箇所、同じ原因で変更される理由を共有する場合は1つの family として扱う。bounded horizontal comparison で見つけた隣接・別 family は、4つの Authorization Basis のいずれにも該当しない限り new finding にせず、修正範囲にも入れない。`direct_acceptance_criterion_violation` も、既に提示された acceptance contract family と identity を共有する場合に限る。異なる担当箇所または同じ原因で変更される理由を必要とする問題は final/follow-up で新しい family にしない。

Companion は、権限のない隣接・別 family を `must_fix`、`should_fix`、`nit`、または実質的な修正要求を残す note に昇格させない。Moderator はそのような指摘を `reject` する。Review Adjudication は技術的に妥当な指摘でも修正権限がなければ `out_of_scope` とし、actionable family や fix plan へ伝播させない。

## Review mode

caller が渡す mode の domain は厳密に `initial | follow_up | unspecified` とする。大小文字違い、別表記、空文字、非文字列を暗黙に正規化しない。

explicit な `initial` または `follow_up` はそのまま使う。`unspecified` または mode absent では、直接実行される reviewer step の iteration が `1` なら `initial`、integer `2` 以上なら `follow_up` とする。不正な mode、または fallback に必要な iteration が未展開、非整数、`1` 未満なら `mode_unknown` とする。

`mode_unknown` では follow-up と同じ権限上限を適用し、accepted family の閉鎖、必須 consumer migration、修正退行だけを確認する。一般初回探索、隣接 family の finding 化、initial coverage 完了を根拠にした APPROVE を禁止する。不正な mode または fallback 理由を evidence に記録する。
