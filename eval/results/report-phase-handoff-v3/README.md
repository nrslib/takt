# 実装レポートの引き継ぎ比較 v3

v1/v2 の独立レビューで判明した採点文脈不足と比較ラベル露出を修正して、旧版から再測定する。
[探索的な v1/v2 記録](../report-phase-handoff/README.md)と元の入力・応答・採点は上書きしない。
歴史的な harness と結果は checkpoint `28eadf50f492ee3507825d40f36b335876c025f6` に保存した。
旧版の実モデル RED を完了し、その確認後に新しい unknown 表現の修正を行った。
初回GREENは17/18で、実際のテスト出典欠落が1件残った。出典保持修正後の最終GREENは18/18だった。
ケース・採点・条件は RED 起動前に固定し、
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
  eval/.results/report-phase-handoff-v3-rerun \
  /private/tmp/takt-handoff-observation-rerun
node eval/scripts/report-phase-handoff-v3.mjs red \
  eval/.results/report-phase-handoff-v3-rerun
```

実モデル呼び出しには認証済み Codex SDK が必要。REDの全18応答・実イベント・実際の意味上の
違反を確認するまで、候補をcaptureせずproductionプロンプトを変更しない。RED確認を記録した
`red-confirmed.json`には、保存した`red/summary.json`のSHA-256を`summaryHash`として書く。
infraがなく真のsemantic REDを確認した後、日英の実装位置のunknown表現を最小修正し、
検証済みcandidate commitを用いて次へ進む。核心の引き継ぎ修正`9fc210c`は今回REDより前から存在する。

```bash
node eval/scripts/report-phase-handoff-v3.mjs capture-candidate 811f3e4ec1d3a0f97782855f727197e72d90bf7c \
  eval/.results/report-phase-handoff-v3-rerun
node eval/scripts/report-phase-handoff-v3.mjs green \
  eval/.results/report-phase-handoff-v3-rerun
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
検証するITで、同じ記録形式と規則が実P1準備資料とP2へ届くことを確認した。

修正後の契約ITは12/12、分類契約の単独実行は42/42、v3 eval契約テストは10/10成功した。
`npm run build`、`npm run lint`、npm test経由の型契約・テスト型検証、`git diff --check`も成功した。
これらは配線・形式と評価境界の検証であり、実モデル GREEN の成功を示すものではない。

## 初回GREENと追加修正

候補 `b199103eb48a31abbf065ddd8d22c29d5f0a8a3d` の初回GREENは **17/18合格、意味上の失敗1件、
infra失敗0件**、終了コード1だった。対象24呼び出しとgrader36呼び出しを完了し、rootが全60traceの
実行条件とhashを監査した。対象P2全18件・grader全36件でtool使用0。execution-boundaryは18/18、
current-obligations / idless-source / state-priority / unknown-implementation / precision-controlは
各6/6、observed-evidenceは5/6だった。

不合格の`en-observed-label-control-r1`では、実P1最終応答に`tests/session-label.test.js:5`と
`src/session-label.js:1`、実build/test成功・具体観測があったが、P2ではtestファイルpathが完全に
欠落した。これは生応答でも確認できる実際の欠落であり、graderの誤採点として扱わない。
日英formatのEvidence欄に、渡されたすべてのテスト名・ファイル位置・その他の証拠出典を
省略せず保持する項目を追加した。未提示の出典情報は未提示と記録し、テスト名・位置を作る義務は
加えず、既存の推測禁止を維持する。

- 初回GREEN summary SHA-256: `c40cf874c006bc6be4f09f4a3ee5e2bc50af46c80968764084f8ce094c950054`
- 両版captureを含む元manifest SHA-256: `615f8c2a3b8b1912788804c6d38e0bc438607c428e9a100501531fded10dc484`

初回RED/GREENと元manifestは上書きしていない。再測定用の新規directory
`eval/.results/report-phase-handoff-v3-r2-20261003/`へ凍結cases、baseline18capture、元RED全artifactと
確認記録を462ファイルbyteそのまま継承した。条件・基準・harness・fixture・neutralRootとpaired18cwdは同じで、
baselineは元の隔離24bビルドを参照する。継承元と全コピーartifactのhash、元manifest/RED/初回GREENの
summary hashを`round-provenance.json`へ記録する。REDの再生成・再採点は0回であり、再測定したとは
主張しない。新候補のGREENだけを全18報告（C P1込み24対象呼び出し、36採点）fresh再生成した。

今回の新規round directoryでは、固定した最終候補を指定した。既存の測定directoryを再実行で上書きしない。

```bash
node eval/scripts/report-phase-handoff-v3.mjs capture-candidate 811f3e4ec1d3a0f97782855f727197e72d90bf7c \
  eval/.results/report-phase-handoff-v3-r2-20261003
node eval/scripts/report-phase-handoff-v3.mjs green \
  eval/.results/report-phase-handoff-v3-r2-20261003
```

## 最終GREENと比較結果

最終候補 `811f3e4ec1d3a0f97782855f727197e72d90bf7c` は **18/18合格、意味上の失敗0件、infra失敗0件**、
終了コード0だった。新しい対象24呼び出しとgrader36呼び出しを完了した。rootが全18P2と全6P1の
生最終応答を読み、全60traceの実 `gpt-6-sol` / `high` / read-only / approval never / fresh、
prompt/output/context hashを監査した。全18実行境界と全6P1の実fixture読了・build/test成功receiptも
別途照合した。対象P2全18件とgrader全36件の実tool使用は0。採点の追加訂正はしていない。

| metric | 旧版RED | 初回GREEN | 最終GREEN |
|---|---:|---:|---:|
| execution-boundary | 18/18 | 18/18 | 18/18 |
| current-obligations | 0/6 | 6/6 | 6/6 |
| idless-source | 0/6 | 6/6 | 6/6 |
| state-priority | 3/6 | 6/6 | 6/6 |
| unknown-implementation | 3/6 | 6/6 | 6/6 |
| observed-evidence | 0/6 | 5/6 | 6/6 |
| precision-control | 4/6 | 6/6 | 6/6 |
| 全条件を満たす報告 | 0/18 | 17/18 | 18/18 |

- 最終summary SHA-256: `d79ee64bae0c4e9b714eaa437ab4d8dc1b5d298949d7c125d659fb09d8913816`
- 最終manifest SHA-256: `7c84e9312c8b5e1a46bb57b7a116f20ce3667243b71cd38eb156c6e4cc21071f`

初回の実欠落は[実P1応答](green-first/en-observed-label-control-r1.phase1.output.md)と
[実P2応答](green-first/en-observed-label-control-r1.output.md)で比較できる。最終の
[同sampleの実P2応答](green-final/en-observed-label-control-r1.output.md)はテスト出典を保持している。
最終の3反復で保持できたことは示すが、1つのプロンプト変更だけの独立した因果効果とは主張しない。

## 公開artifactと監査

[RED集計](red-summary.json)、[初回GREEN集計](green-first-summary.json)、
[最終GREEN集計](green-final-summary.json)は元の合否とcomponent理由を保持する。
`red/`・`green-first/`・`green-final/`に全54件のP2最終応答と18件の実P1最終応答を
元のbyteのままコピーした。各集計には出力・元prompt・実trace・実capture・grader専用reference/contextの
hashを記録している。graderのprompt/response/trace hashと実条件も全36件ずつ保持する。

実P1の`selectedVerification`は、読了・成功build/testを示す必要な実command receiptの選択抜粋である。
receipt本文は変更せず、元trace hash・元command index・全command数を付けた派生記録で、完全なtraceではない。
policy/knowledge dump、推論、private-turn、内部session ID、認証情報は公開していない。
全promptfoo JSON、全promptと完全な実trace・採点文脈はローカルの新旧結果directoryへ保持している。

[protocol metadata](protocol-metadata.json)は事前に固定した共通conditions、fixture/harness hashes、
全18sampleのinput/rubric hashes、各revisionの全18capture hashesを比較できる形でまとめた。
462copyの継承数・元manifest/RED/初回GREEN hashesとcopy inventory hashも保持する。
継承REDを新たに生成・採点した結果と取り違えないよう、round provenanceを併記した。
公開metadataは派生記録であり、repositoryのpathを相対化し、metadata内のneutral workspaceを
`<neutral-workspace>`へ置換した。元のmanifest/provenanceと同じbyteやhashを持つファイルとは
主張しない。`sourceProvenanceHash`とcopy inventory等のhashは、正規化前の元artifactを指す。
全72生応答は実neutral pathを含めbyteそのまま保持した。

公開時に全応答のexact copy、各source/output/trace/context hash、継承byte一致と凍結harness/criteria不変を
再照合し、credential pattern scanを行った。`git diff --check`も成功した。

## ソース検証と限界

最終ソース候補`811f3e4e`でunit6699件/416filesと型検証、light IT2770件/166filesが成功した。
同候補のfocused IT12件、分類契約42件、v3契約10件、build/lintも成功。
直前の候補`b199103e`でsmoke19件成功・既存skip1件、既存eval契約44件成功を確認した。
当初の最終結果公開時点の変更は文書と公開artifactだけだった。凍結済み当時のcriteria/harness・
production source・実測応答は不変である。現行runnerの測定後の修正は次節で区別する。

unitログは`/private/tmp/report-handoff-v3-r2-final-unit-20261003.log`、light ITログは
`/private/tmp/report-handoff-v3-r2-final-light-it-20261003.log`、最終モデルログは
`/private/tmp/report-handoff-v3-r2-green-20261003.log`にある。

測定は3つの固定ケースと1種類のmodel/effort、各言語3反復に限る。Cは既知の正常precision controlで、
新規heldoutによる一般化の証明ではない。正確なtest行番号は採点しておらず、適切なtestファイルpathで足りる。
本物のengine/AgentRunnerの選択した経路とwrapped promptを測る一方、A/Bは合成要約、status conductorは
評価用の固定制御、provider実装はcapture時にstubを使う。full status judge、全workflow/provider、他モデルや
実装一般への改善を示すものではない。核心の引き継ぎ修正・unknown修正・出典保持修正やP1準備文の
独立した効果を切り分けた実験でもない。LLMによる意味採点の変動は残る。

## 測定後のharness監査修正

保存した0/18・17/18・18/18は、ソースrevision `811f3e4ec1d3a0f97782855f727197e72d90bf7c` の
当時のv3 harnessを用いた結果である。metadataの当時の全harness hashesは同revisionのGit保存本文と
照合できる。以下のharness修正は独立レビュー後の変更であり、保存済みの測定で使ったとは主張しない。
原manifest・trace・応答・採点は変更せず、このv3保存結果の追加生成や再採点も行っていない。

v3のitem監査がSDKの`todo_list`をツールに数えていたため、進捗項目として除外した。
command実行・file change・MCP・web search等は引き続き使用として数え、SDK error項目はinfraへ扱う。
今回保存した各測定のP2全18件とgrader全36件はtoolTypesがすべて空で、この訂正による合否変更はない。

当時のmanifestにはNode versionはあるが、実行開始時のnpm version・lockfile hash・実依存ツリーの
snapshotはない。これらの当時の値は不明であり、現在の環境から過去の値を補っていない。
新規freezeではrootの`package-lock.json` hash、Node/npm実version、`npm ls --all --json`の
実versionと依存構造（extraneous項目を含む）、主要runtime packageの実解決version/package metadata hashを
記録する。パスやregistry URLはsnapshotへ含めない。candidate captureとRED/GREEN phaseの前後に
照合し、不一致・収集不能・未凍結はinfraとしてexit 2で停止する。そのphaseを有効な意味上のRED/GREENへ数えない。
これは依存version・構造・metadataのガードであり、全dependencyファイル本文の署名ではない。

現在のrunnerで過去のmanifestを再実行することはできない。上の新規directoryによる再現手順は
新しいguardを使う将来の測定用であり、保存結果の当時のharness本文は`git show 811f3e4e:<path>`で確認する。
モデルを使わないv3契約テストはTODOと実toolの区別、SDK error、実lockfile/version/依存構造のdrift、
未凍結時にSDK呼び出し前にexit 2となることを検証する。
監査修正後にv3契約13件、build/lint、`test:types`が成功した。ログは
`/private/tmp/report-handoff-v3-r3-{contract,build,lint,types}-20261003.log`に保持した。
今回の追加変更は評価harness・そのテスト・文書/公開metadataであり、production promptと採点基準は変更していない。

その後の独立レビューで、fresh条件の違反が通常の意味上の失敗へ分類される経路と、A/Bの合成要約が
grader参照の`actualPhase1FinalResponse`という項目名で渡ることを確認した。保存したA/Bの資料は合成であり、
実P1応答ではない。保存済みの参照データと採点はそのまま保持する。この項目名だけから採点の誤りを立証した
とは扱わない。

現行harnessはP1/P2/graderのfresh条件を実行監査として検証し、不成立ならinfraへ分類する。
合成要約は由来を明記した`syntheticPhase1Handoff`、実CのP1応答は`actualPhase1FinalResponse`へ分けた。
これらは保存済みの0/18・17/18・18/18では使っていない測定後の修正で、モデルでの効果は未実測である。
当時の全P2/graderはfresh、Cの実P1もfreshだったため、保存結果の合否を変更する理由にはならない。
追加生成・再採点は0であり、基準、production prompt、原応答、原summary、元grader文脈/hashは不変である。
後続修正の契約検証と当時のfollow-up harnessの保存revisionは
[follow-upの監査記録](../report-feasibility/README.md#測定時のharnessと後続修正)に記載した。

続く独立レビューでは、読取コマンド全体のstdoutに別コマンドの合成本文が混ざると、読了と誤認する穴を
確認した。一時fixtureで実際に`cat ... > /dev/null; printf <fixture全文>`を実行し、その実receiptを
Git `622d627cf`の旧監査が誤受理するREDと、修正後が拒否するGREENを契約テストで確認した。
これは読取監査のローカル検証であり、保存済みモデル応答の新規生成や採点ではない。
旧監査との比較は履歴が存在する作業環境で一度実施した記録として保持する。永久回帰テストは
同じ実シェル偽装receiptを現行監査が拒否することを検証し、旧Git履歴の有無には依存しない。
空bare Gitを`GIT_DIR`に指定した対象テストは1件実行・1件成功した。全契約を同じbare条件で実行すると
21/24成功で、残る3件は実engineの通常Git操作にworktreeがなく失敗した。
履歴0の通常Git repositoryを使った全24契約は24/24成功し、通常環境の全24契約も成功した。
さらに旧`622d627cf`を持たず、fixture用の空commit1つだけを持つ通常Git repositoryでも24/24成功した。
そのログは`/private/tmp/report-handoff-r6-valid-checkout-contract-20261003.log`に保持した。
追加検査のログは`/private/tmp/report-handoff-r6-no-history-{green,contract,worktree-contract}-20261003.log`、
通常契約は`/private/tmp/report-handoff-r6-contract-20261003.log`に保持した。
build/lint/型検証も成功し、ログは`/private/tmp/report-handoff-r6-{build,lint,types}-20261003.log`に保持した。

現行監査は本文を変えないcat/nl、数値範囲のsed/headと、限定したrg検索・一覧、checksum、git status等の
観測コマンドの組合せを扱う。出力redirect、command substitution、後続echo/printf、本文を合成するsed scriptや
rg置換等で出力の帰属を保証できない形式はinfraへ分類する。正当な部分読取に本文証拠が足りない場合は
意味上の不足として区別する。一般的なshell全体の解析器ではなく、未対応の複合形式を有効なREDへ数えない。
保存済み3段階のC実P1全18件について、元safe traceのbyte hashと公開選択receiptのbyte/hashを照合し、
実際の読取形式が修正後もすべて受理されることを確認した。読取監査の修正も過去の実測では未使用であり、
原結果・応答・採点文脈を変更せず、追加モデル呼び出しと再採点は0である。
修正後の契約24件、build/lint/型検証と`git diff --check`が成功した。契約の最終ログは
`/private/tmp/report-handoff-r5-contract-final-20261003.log`、他の検証ログは
`/private/tmp/report-handoff-r5-{build,lint,types}-20261003.log`に保持した。

後続監査ではnpmのscript-shellを実在する`true` executableへ変え、未実行のテスト出力をprintfで作る
実シェル偽装と、正当なawk全文読取が意味上の不足になる経路を、それぞれ契約のREDで確認した。
現行監査はnpmの単独実行または`npm run build && npm test`だけを許可し、環境変更や後続合成出力をinfraへ扱う。
未対応の言語reader・regex・optionもinfra、既知の部分読取やファイル名の言及は証拠不足として分ける。
保存済みの補助node関数観測はファイル本文の読取証拠へ数えない。

future v3/follow-upだけのopt-inで、`npm_config_script_shell=/bin/sh`と`npm_config_ignore_scripts=false`を
コピーしたSDK環境とtool用の`shell_environment_policy.set`へ指定する。実行前の`npm config get`実値を
future trace・dependency snapshot・conditionsへ記録し、親環境やcredential値は記録しない。
設定を未指定のlegacy評価と本体は変更せず、global `process.env`の並列変更も行わない。
[SDK 0.159.2の環境伝達実装](https://github.com/openai/codex/blob/rust-v0.159.2/sdk/typescript/src/exec.ts)と
[CLI 0.159.2のtool環境生成](https://raw.githubusercontent.com/openai/codex/rust-v0.159.2/codex-rs/protocol/src/shell_environment.rs)を確認した。
lockfileと現行のinstalled SDK/CLI依存はともに0.159.2で、SDKの既定選択はnpm依存のplatform binaryである。
先に参照したPATH上のCLI 0.160.0は比較用資料であり、SDKが実行するCLI版の根拠ではない。
ローカルprobeは`codexPathOverride`で指定した自作CLI stubへ、実SDKがenv/configを伝達する検査である。
実CLIのtoolを動かした検査ではない。ローカルnpmの実効値も検証済みだが、
修正後の実モデルtool環境・挙動は未測定である。過去の実効script-shellは記録がなく不明として残す。
現行依存の確認を、記録済みモデル測定時のCLI binary版の実行時記録として後付けしない。
保存済み18P1の36件の直接npm receiptと全18組の本文読取は、元byte/hashを保持したまま新監査でも受理した。
原結果の再生成・再採点は0である。契約29件、build/lint/型検証、diffcheckが成功し、ログは
`/private/tmp/report-handoff-r7-{red,green,policy-contract,contract,build,lint,types}-20261003.log`に保持した。

次の監査では、実シェルの`dd if=src/session-label.js`と`nice npm test`が未対応なのに意味上の不足へ
落ちるREDを確認した。コマンド名のblacklistを置き換え、対象本文・パスまたはnpm実行に関わる形式は、
対応済みの証拠操作か明確な補助観測でなければinfraへ分類する。ファイル名の単純な言及、`wc -l`、
checksumと既存の補助関数観測は本文証拠に数えない。永久契約は両実コマンドと未知の形式を検証する。
修正後の全30契約、build/lint/型検証、diffcheckが成功し、保存済み18実P1のsafe trace hashと選択receiptの
hashを照合して、18組の本文読取と36 npm receiptの受理も確認した。追加モデル・再採点は0で、
この境界修正も過去の実測では未使用である。ログは
`/private/tmp/report-handoff-r8-{red,nice-red,green,contract,original-receipts,build,lint,types}-20261003.log`に保持した。

`cat src/*.js`が直接指定とbyte-identicalの全文を出しても、展開後のパスへ帰属できず意味上の不足へ
落ちる経路も実シェル契約のREDで確認した。今後の監査は、本文が出た既知readerでも未対応path展開や
shell構成の帰属不能をinfraへ分類し、glob展開自体は実装しない。明示的な別ファイルと通常の部分読取は
証拠不足として区別する。全31契約とbuild/lint/型検証・diffcheckが成功し、元safe trace／receipt hashと
18組の読取・36 npm receiptの受理を再確認した。原実測・採点は不変で、修正後のモデル効果は未測定である。
ログは`/private/tmp/report-handoff-r9-{glob-red,glob-green,contract,original-receipts,build,lint,types}-20261003.log`に保持した。

部分出力の`head -n 1 src/*.js`でも未対応パスを見逃す経路を、実シェル契約のREDで確認した。
今後の監査は読取パスの展開検査を本文量判定より前に行い、rgの検索フィルターと実際の入力パスを分ける。
部分globをinfra、明示パスの通常部分読取を証拠不足へ分類する契約が成功し、全32契約・build/lint/型検証・
diffcheckも成功した。元hashを照合した18組の読取・36 npm receiptは引き続き受理した。
原結果・採点は不変で、この修正の実モデル効果も未測定である。ログは
`/private/tmp/report-handoff-r11-{red,green,contract,original-receipts,build,lint,types}-20261003.log`に保持した。

後続の実シェル契約で、ディレクトリ指定の本文検索、明示パスの分割sed読取、fixture内のcwd変更後の
読取を取りこぼすREDを3件確認した。今後の監査はディレクトリ本文検索を走査せずinfraへ分類し、
分割読取は実fixtureの連続行と一致する範囲だけを集約する。全行を覆わない範囲や内容不一致は証拠不足、
偽造・未知形式はinfraとして区別する。読取は解決した明示対象パスで帰属を確認し、npmのcwd制約は維持する。
修正後のfocused7件と全35契約、build/lint/型検証・diffcheckが成功した。

旧ログだけではbuild/lint/型検証・diffcheckの終了コードを独立照合できなかったため、今回の新規実行は
[構造化検証receipt](verification-r12.json)へcommand・exitCode・status・stdout/stderr hashを保存した。
これは現行のfuture harnessの新規ローカル検証であり、以前のopaqueログやモデル測定へ終了コードを後付け
した記録ではない。実stdout/stderrはreceiptにあるlog名で`/private/tmp/`に保持する。
元144公開artifactとproduction・ケース・fixtureの不変、元safe trace／receipt hashと18組の読取・36 npmの
受理も照合した。原結果・採点は不変で、追加モデル・再採点は0、修正後のモデル効果は未測定である。

未知のcat optionについては、実`cat -e`を使ったbaseline契約が既存ガードでinfraとなり、追加REDは
再現しなかった。永久契約でその分類を固定し、新たな出力正規化は追加していない。
合成handoffの境界成功理由が「actual fixture receipts verified」と誤称するREDは確認し、future harnessでは
実P1 receiptの検証を行わない合成handoffと、実P1 fixtureを検証したケースの理由を分けた。
保存済みの元理由・採点・結果は書き換えていない。
R13時点の中間harnessでfocused5件・全37契約とbuild/lint/型検証・diffcheckが成功した記録は、別の
[R13検証receipt](verification-r13.json)へ保存した。R12 receiptは元hashのまま保持し、現行7 source、
原144 artifact・production・ケース・fixture、元18組の読取・36 npm receiptも再照合した。
追加モデル・再採点は0で、成功理由修正の実モデル効果も未測定である。

追加引数のある実bash wrapperがfixture全文を出してもparser失敗時に読み飛ばされるREDを確認した。
future harnessでは名前によるskipを削除し、解析不能なコマンド形式をそのままinfraへ分類する。
新たなshell形式は実装していない。全文・部分出力・補助出力のwrapperを契約に含め、通常の明示パスによる
部分読取の証拠不足とは区別する。R14時点の中間harnessでfocused8件・全38契約とbuild/lint/型検証・diffcheckの新規実行記録は
[R14検証receipt](verification-r14.json)へ保存した。現行7 sourceと実stdout/stderr hashを照合し、
R12/R13 receipt・原144 artifact・production・ケース・fixture・元18組の読取・36 npmの不変も確認した。
原結果・採点は変更せず、追加モデル・再採点は0で、この修正の実モデル効果も未測定である。

直接npmがexit0でも固定fixtureの出力がない場合と、Node builtinによる部分読取を補助probeへ偽装する場合を、
実コマンドのRED2件で確認した。前者はscript-shellをtrueへ逸脱させた実環境で、裸npmが終了コード0・出力なし・
script実行markerなしとなることを確認した。今後の監査では成功終了したbuild/testの期待出力欠落をinfraへ分類し、
実npmテストの終了コード1は意味上の失敗として保持する。補助Node probeは保存済みの純粋な1式だけを完全一致で
許可し、その他のNode形式は監査不能とする。許可したprobeもファイル本文を読んだ証拠には数えない。
JavaScriptの一般解析や新しいreaderは追加していない。

R15時点の中間harnessでfocused6件・全41契約、build/lint/型検証・diffcheckの新規実行は
[R15検証receipt](verification-r15.json)に保存した。現行7 source・実stdout/stderr hashを照合し、
R12/R13/R14 receipt、原144 artifact・production・ケース・fixtureの不変、元18組の読取・36 npmと
保存済み補助Node probeの受理も確認した。原モデル測定時の実効script-shellは記録されていない範囲が不明であり、
今回のガードを過去測定へ適用した記録ではない。追加モデル・再採点は0で、修正後の実モデル効果は未測定である。

実`rg -n '.*' -g '*.js' src`がfixture本文を出しても、未対応のglob指定を空の読取結果へ変換して
意味上の証拠不足にするREDを確認した。今後の監査は本文検索の`-g/--glob`を発見した地点でinfraへ分類する。
glob展開やディレクトリ走査は追加していない。保存済みの`rg --files -g ...`は既知のファイル名一覧として
保持し、読取証拠には数えない。また、保存済みのsymbol検索5形式も完全一致の補助観測としてのみ
許可し、本文の証拠には数えない。一般のglob本文検索はinfraとなる。全文・部分出力の両方と短長両optionを契約化し、通常の
明示パスの全文読取は受理、既知の部分読取は意味上の証拠不足として保持する。
R16時点の中間harnessでfocused5件・全42契約とbuild/lint/型検証・diffcheckの新規実行は
[R16検証receipt](verification-r16.json)へ保存した。現行7 source・stdout/stderr hashと、原144 artifact、
production・ケース・fixture・R12〜R15 receiptの不変、元18組の読取・36 npmと純粋Node probeの受理を
再照合した。原モデル結果・採点は変更せず、追加モデル・再採点は0、この修正の実モデル効果は未測定である。

未知のreaderがfixture名を含まず一部だけを出す実subprocessと、baseline準備のnpm設定確立失敗が
未処理終了になる実entrypointでRED2件を確認した。今後の監査は名前・出力によるunknown skipを廃止し、
対応read/npm、明示した既知のmetadata・literal echo、保存済み純粋probe・補助検索以外をinfraにする。
保存済みのsort・ls・findは既知の引数形式のみをmetadataとして保持し、本文読取の証拠には数えない。
通常の部分読取の証拠不足は意味上の失敗のままとする。v3/feasibility両entrypointのnpm設定監査エラーは
依存監査と同じinfra終了へ通し、モデル呼び出し前の失敗として契約化した。

R17時点の中間harnessでfocused6件・全44契約、build/lint/型検証・integrity・diffcheckの新規実行は
[R17検証receipt](verification-r17.json)へ保存した。過去R12〜R16 receiptは無改変である。
今回の一回限りの[不変性検査本文](verification-r17-integrity.py)と
[安全な実stdout](verification-r17-integrity.stdout.txt)も公開し、receiptの`verificationSources`と
`publishedVerificationOutputs`に本文・結果のhashを記録した。検査には当時のGit objects、インストール済み依存と
ローカルignored `.results` 内の実P1 safe traceが必要で、公開artifactだけで全検査を再実行できるものではない。
公開本文から検査対象・方法を確認でき、結果には原144 artifact・production・固定入力・過去receiptの不変と、
元18組のread・36 npmの受理を記録する。これは新harnessのローカル検証で、原測定への終了コードの後付けや
再採点ではない。追加モデル・再採点は0、修正後の実モデル効果は未測定である。

実`cd src* && cat session-label.js`がfixture全文を読んでも、展開前の文字列をcwdへ結合して証拠不足とする
REDを確認した。今後の監査は`cd`先のglob・チルダ・変数等の未対応展開構文をresolve前にinfraへ分類する。
展開成功への対応は追加せず、通常の明示サブディレクトリ読取は受理し、通常部分読取の意味上の証拠不足は保持する。
focused5件・全45契約とbuild/lint/型検証・integrity・diffcheckの新規実行は
[R18検証receipt](verification-r18.json)へ保存した。今回の[検査本文](verification-r18-integrity.py)と
[安全stdout](verification-r18-integrity.stdout.txt)のhashもreceiptへ結び付けた。
R17検査本文・結果・receiptおよびR12〜R16 receiptは元hashのまま保持する。検査に必要な過去Git object・
インストール済み依存・ローカルignored safe traceという再現境界はR17と同じである。
原144 artifact・production・固定入力の不変と、元18組のread・36 npm・純粋probe・補助観測の受理を再確認した。
原測定・採点は変更せず、追加モデル・再採点は0で、このfuture guard修正の実モデル効果は未測定である。

## 追加の論理監査

指示と実行/evalを分けたSol 2体の読み取り専用レビューでは、同じ主体・工程・条件で両立不能な
厳密矛盾は未確認だった。本文が渡らない参照、変更・撤回、IDなし出典、環境阻害と観測失敗、
実装箇所不明は、成立条件を伴う入力欠落や用語の曖昧さとして分類された。
例えばP1で証拠を残しP2でその本文を報告する場合、P1の証拠収集とP2のツール禁止は両立する。
元計画から変更がない場合も、上流義務の保持と後入力の優先は競合しない。

追加の曖昧さは未確認範囲の「現行計画内で実行可能か（可能/不可）」だった。情報不足時の不明を
欠き、P2の報告工程の禁止と実装/再実装工程の可否を混同し得る。
[JA B r3](green-final/ja-rule-source-status-r3.output.md)にはP2のソース変更禁止を修正不可の根拠にした実例があり、
[EN B r1](green-final/en-rule-source-status-r1.output.md)はtimestampの可否を不明と記録した。
既存Bは実装工程での修正可能性の根拠を提示していないため、後から「可能」を必須採点へ加えていない。
この問題は[独立follow-up](../report-feasibility/README.md)で基準を別に固定して測った。
原機械集計5/6の唯一の不合格は直接ラベル要求によるものとして判定が争われ、root/writerの原文監査は
対象の意味上の違反を確認しなかった。追加の真のREDは未確認で、production追加修正は見送った。
global orderの推測禁止と不明を保持した6報告を踏まえ、二択placeholderを閉じたenumの厳密矛盾とは
断定せず、対象工程・表示方法の補足余地として残した。
既存の0/18→17/18→18/18と72応答は再採点せず保持する。全条件・全workflowに厳密矛盾がないという
証明や、既存の合格が今回の可否規則まで検証したという主張ではない。
