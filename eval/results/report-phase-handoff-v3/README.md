# 実装レポートの引き継ぎ比較 v3

v1/v2 の独立レビューで判明した採点文脈不足と比較ラベル露出を修正して、旧版から再測定する。
[探索的な v1/v2 記録](../report-phase-handoff/README.md)と元の入力・応答・採点は上書きしない。
歴史的な harness と結果は checkpoint `28eadf50f492ee3507825d40f36b335876c025f6` に保存した。
旧版の実モデル RED を完了し、その確認後に新しい unknown 表現の修正を行った。
GREEN は未実施であり、改善効果はまだ確定していない。ケース・採点・条件は RED 起動前に固定し、
同じ入力・基準を用いる前向きの v3 比較として進める。

## 事前に固定する問題と基準

ケース入力は v1 と同じ3ケースで、採点条件を
[cases/report-phase-handoff-v3.json](../../cases/report-phase-handoff-v3.json)に定義する。

| ケース | 必須の結果 |
|---|---|
| A: revised-export | 実 dispatch 済み live 指示で NOTICE-02 を撤回し、通常の追加要求で EXPORT-01 をマスク出力へ変更する。現行義務の ID、Plan 由来、観測、Verified を保持し、古い義務を復活させない |
| B: rule-source-status | 実 reportContent の3義務の意味と実在する行位置を照合する。既知の version 失敗は Incomplete、唯一の credential 阻害は Environment-limited、原因不明の未実行は Incomplete。timestamp の実装状態・位置は不明を保持し、未実装を断定しない |
| C: observed-label-control | 実 P1 が小関数とテストを読み、npm build/test を実行した最終応答を新規 P2へ渡す。2行の ID/Plan/意味/実装file:line/test path/具体観測/成功を Verified とともに保持する。非該当の経路・別台帳・REQ/SCOPE行を追加義務にしない |

A/B の P1 要約は合成された固定入力である。C は実モデル P1 の応答と実コマンドを用いる。
C の処理本体は完成済みで、認証や外部通信は不要。実装位置は関数宣言の1行目または本体の
2行目でよく、test位置には適切なファイルpathで足りる。証拠や位置を P1 が最終応答へ
残せず、P2 が正しく不足を認めた場合も、この end-to-end の正常ケースは不合格となる。
C は v1/v2 でも用いた正常な precision control であり、未知の新規 heldout による一般化の検証ではない。

全ケースの grader に実 task・上流記録・追加入力・実 dispatch 済み live・実 P1 要約/応答を
渡す。B は元の reportContent と実 line付き本文、C は line付き immutable fixture と実際に
確認できた必要な receipt も渡す。これらは grader 専用の参考文脈であり、P1/P2の欠落を
補完して合格にすることは禁止する。対象プロンプトへ rubric や参照情報を追加しない。

## 測定境界と条件

対象・grader とも `gpt-6-sol` / `high`、read-only / approval never、新規 SDK session。
network/Web と repo/user skills 継承を無効、cache false、maxConcurrency 3。
日英テンプレート各3ケース×3反復で、各 revision は18報告、C P1込み24対象呼び出し、
意味採点36回となる。日英はテンプレートの比較であり、完全な英語出力品質の測定とはしない。

対応する両 revision の sample は `/private/tmp/` 内の同じ中立的な絶対 cwd を使う。
case・言語・反復ごとに別の workspace とし、比較ラベルや commit SHA を対象に提示しない。
revisionコピーと結果出力先は workspace 外へ置く。sample開始時に fixture と engine 資産を
すべて resetし、captureごとに `.takt` を再生成する。実モデルのP1/P2実行後にも immutable
3ファイルのhashを照合する。captureのstubが書いた将来のレポートは実P1前に削除する。
engine captureの clockは固定し、生成されるcontext pathを揃える。
実モデルの clock は変更しない。

実 WorkflowEngine と AgentRunner を通し、CodexProvider.setup/call だけを置き換えて payloadを
captureする。実 `onPromptResolved` の wrapped systemPrompt と userInstruction が providerへ
渡った内容と一致することを確認し、本番CodexのfullPromptと同じ順序で連結する。
workflowは実 builtin development-implement の implement step と実装レポートを使い、評価用の
上流 step・完了遷移・status conductorを制御する。これは実 engine/runner のプロンプト生成の
測定であり、provider全体やstatus judgeの自由な実行を測るものではない。

P2のproduction payloadがallowedTools=[]で新規sessionとなることをcaptureで確認し、実P2の
ツール使用は不合格。SDK read-only自体はshell/readを許すので、hard disableとは主張しない。
graderにはツール禁止を指示し、実tool itemが出た採点は infrastructure failure として扱う。
APIエラー・空応答・未対応のコマンド監査・graderエラーも semantic RED に数えない。

P1監査は通常の `/bin/zsh -lc` / bash・sh wrapper、cat/sed/nl/head/rgの実ファイル本文、
単独 `npm run build`・`npm test`・`npm run test`と`&&`連結を扱う。npmの終了結果を確認できない
composition、env/command/exec/timeoutによるnpm wrapper、npmの追加option・絶対executableや
環境代入は監査未対応としてinfra扱い。echoに書かれたコマンド、`rg --files`や名前だけの出力は
実行・読了として扱わない。2観測は対象fixtureの成功したnpm test receipt内の構造化JSONと
2pass/0failへ結び付け、別のecho/stdoutから補完しない。

## 再現手順

```bash
npm run build
node --test eval/asserts/report-phase-handoff-v3.test.mjs
npm test -- src/__tests__/it-report-input-contracts.test.ts
npm test -- src/__tests__/releaseVerificationWiring.test.ts
node eval/scripts/report-phase-handoff-v3.mjs freeze-baseline \
  24b6990a4767602e8ec52fce7e1f6e56d0e4982a \
  eval/.results/report-phase-handoff-v3-20261003 \
  /private/tmp/takt-handoff-observation-20261003
node eval/scripts/report-phase-handoff-v3.mjs red \
  eval/.results/report-phase-handoff-v3-20261003
```

実モデル呼び出しには認証済み Codex SDK が必要。REDの全18応答・実イベント・実際の意味上の
違反を確認するまで、候補をcaptureせずproductionプロンプトを変更しない。RED確認を記録した
`red-confirmed.json`には、保存した`red/summary.json`のSHA-256を`summaryHash`として書く。
infraがなく真のsemantic REDを確認した後、日英の実装位置のunknown表現を最小修正し、
検証済みcandidate commitを用いて次へ進む。核心の引き継ぎ修正`9fc210c`は今回REDより前から存在する。

```bash
node eval/scripts/report-phase-handoff-v3.mjs capture-candidate CANDIDATE_COMMIT \
  eval/.results/report-phase-handoff-v3-20261003
node eval/scripts/report-phase-handoff-v3.mjs green \
  eval/.results/report-phase-handoff-v3-20261003
```

cases/criteria・harness hash・fixture hash・conditions hash・全captureprompt hashをmanifestに保存し、
実行時に一致を確認する。graderごとのrubric/reference/元対象応答/実prompt hashも保持する。
全JSON・prompt・応答・trace・receiptを新規`eval/.results/report-phase-handoff-v3-20261003/`に保存する。
終了コード1は意味上の不合格、2はinfra失敗であり、APIエラーをREDとして扱わない。

## RED と確認後の修正

旧版 `24b6990a4767602e8ec52fce7e1f6e56d0e4982a` の v3 RED は **0/18 合格、
意味上の失敗18件、infra失敗0件**、終了コード1だった。対象24呼び出しとgrader36呼び出しを
完了した。rootが全18P2と全6P1最終応答を読み、全60traceの実 model/effort/read-only/never/
fresh と prompt/response hash を照合した。対象P2全18件、grader全36件とも実tool使用0。

| RED metric | 合格 |
|---|---:|
| execution-boundary | 18/18 |
| current-obligations | 0/6 |
| idless-source | 0/6 |
| state-priority | 3/6 |
| unknown-implementation | 3/6 |
| observed-evidence | 0/6 |
| precision-control | 4/6 |

A全6件で現行要求のID・変更・撤回が失われ、古い平文出力や通知を未達義務として復活させた。
Bでは実report本文の出典が落ちた。CではPlan由来の改変や契約行の消失があり、日本語2反復目では
実P1最終応答から実装lineが落ち、P2にも保持できなかった。実コマンド成功や分類が旧版でも
できた例はあり、これらすべてを修正による新たな能力とは主張しない。

- manifest SHA-256: `53e70fadcc9a94037838019baddcb3610ad28c70a1354af4dbe390fe18bff6e0`（baselineのみの凍結時点）
- cases SHA-256: `aea7ba6d041914683dfb9a5f77a519db05923e5362750abdd204cb9ad280b2bb`
- conditions SHA-256: `23d331d78977f2958020095dbdce390b83896e98506240418bf0ae6704b43d8f`
- RED summary SHA-256: `b5a7a3dc2d79c9fbb0cb87514896f296f05ca960e5e2f36f743d632bea497f45`

REDの生promptfoo JSON、全応答・prompt・trace・採点文脈は新規結果directoryの`red/`に保持し、
rootの意味上の確認は`red-confirmed.json`に保存した。ログは
`/private/tmp/report-handoff-v3-red-20261003.log`。元の応答や採点を変更していない。

引き継ぎの核心修正 `9fc210c` はこのRED以前から存在する。新しい修正はRED確認後に行い、
日英の実装レポートformatに実装状態・箇所未確認の「不明」を追加し、orderに情報・検証不足だけで
未実装を断定しない規則を加えた。「未実装」は実装の不存在を確認した場合だけに限定する。
完了契約の状態語彙・優先順位・既存行ID・影響経路列は変更していない。実workflowからの展開を
検証するITで、同じ記録形式と規則が実P1準備資料とP2へ届くことを確認する。

修正後の契約ITは12/12、分類契約の単独実行は42/42、v3 eval契約テストは10/10成功した。
`npm run build`、`npm run lint`、npm test経由の型契約・テスト型検証、`git diff --check`も成功した。
これらは配線・形式と評価境界の検証であり、実モデル GREEN の成功を示すものではない。
