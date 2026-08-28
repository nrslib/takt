# PR #1513 static path audit provenance

この文書は評価資産の保守者向けの対応根拠であり、候補モデルへ渡す task、report seed、fixture にはコピーしない。`prepare` は各 suite の fixture だけを Codex の isolated working directory へ渡す。

52 iteration の実ログで `plan_invalid` になった時刻と、今回の独立ケースへ切り出した finding/path 群を対応付ける。

## Primary artifact identifiers

今回の対応で参照した一次 artifact は次の識別子で固定する。絶対 filesystem path は保存せず、writer artifact は run/report の相対形式で記録する。

- run ID: `20260826-002857-implement-using-only-the-files-rpowzl`
- remediation site: `iteration-1--step-remediation--workflow-development-remediation-dynamic--site-d30e838f446e549017c2f8cf820299ed12f7c957fde08b5efe78a8dbdeb6b5fe`
- history key: `8bfbe0407870f972933f8ea261dff9e02f27bd8e47a404e076787ba85a0bd863`
- writer artifact root: `.takt/runs/<run-id>/reports/subworkflows/.../.takt-report-internal/history/<key>/writer/`

| 対応 suite | 確認済み writer artifact | finding ID | artifact で確認した要旨 |
| --- | --- | --- | --- |
| `fix-plan-static-path-audit-a` | `.takt/runs/<run-id>/reports/subworkflows/.../.takt-report-internal/history/<key>/writer/fix-verification.md.20260826T074518Z` | `WM-ARCH-001`, `AI-WM-NEW-L523` | 正本から selector、workflow cycle、loop monitor instruction の各 consumer までの閉包が計画に分離されず、代表例だけでは再検証できなかった |
| `fix-plan-static-path-audit-b` | `.takt/runs/<run-id>/reports/subworkflows/.../.takt-report-internal/history/<key>/writer/fix-verification.md.20260826T085750Z` | `WM-ARCH-001` | report order と source/template/merge の生成経路が同じ artifact 閉包として追跡されず、実入力から統合 terminal までの証拠が不足した |
| `fix-plan-static-path-audit-c` | `.takt/runs/<run-id>/reports/subworkflows/.../.takt-report-internal/history/<key>/writer/fix-verification.md.20260826T102630Z` | `WM-ARCH-001` | direct companion、reference 引数、capability mode、package 境界を単一の呼出し例で代用し、兄弟経路の閉包と unknown rejection を確認できなかった |

| 独立 suite | 実ログ時刻 (JST) | ログで確認した finding/path 群 | 評価資産での境界 |
| --- | --- | --- | --- |
| `fix-plan-static-path-audit-a` | `074518` (07:45:18 JST) | dynamic facet selector の persona/instruction、workflow call cycle、loop monitor judge instruction の影響経路が正本から consumer まで分離されなかった | 実行選択・循環・反復判定を一つの fixture に混ぜず、threshold を含む到達可能な経路として検証 |
| `fix-plan-static-path-audit-b` | `085750` (08:57:50 JST) | report order と、Arpeggio の source path・template 展開・merge file への生成経路が列挙に留まった | 実ファイル入力を読み、template を展開し、merge file を生成する consumer と反証を fixture に保持 |
| `fix-plan-static-path-audit-c` | `102630` (10:26:30 JST) | direct companion、companion reference の default/explicit args、capability mode、package scoped facet の境界が単一例で代用された | default と explicit、3 mode、同名 facet を持つ package 境界、unknown rejection を独立 state として検証 |

この対応表はログ監査の provenance であり、candidate の task や seeded report の受入要件ではない。各 rubric は対応する fixture の正本だけを根拠に採点する。
