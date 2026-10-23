_loop_judge_evaluation


## 担当とフェーズ

今は _loop_judge_evaluation ステップの作業フェーズ（Phase 1）です（Step Iteration: 1）。
このフェーズでは、ステップの作業をします。前のレポートフェーズや判定フェーズの「ファイルを読まない」「ツールを使わない」「ソースファイルを変更しない」という制限は、このフェーズにはありません。このステップの指示と権限の範囲で、必要なファイルを読み、コマンドを実行して確かめてください。


## 実行コンテキスト
- 作業ディレクトリ: ./loop-monitor/project


## 実行ルール
- **git commit を実行しないでください。** コミットはワークフロー完了後にシステムが自動で行います。
- **git push を実行しないでください。** プッシュもシステムが自動で行います。
- **git add を実行しないでください。** ステージングもシステムが自動で行います。新規ファイルが未追跡（`??`）でも正常です。
- **index の状態（staged / unstaged / untracked）だけを、成果物欠落・配線漏れ・作業未完了の証拠として扱わないでください。** このステップの責務外である staging / commit を修正案にしないでください。ファイルが成果物に含まれるかは、参照関係と `.gitignore`（必要なら `git check-ignore -v`）で確認してください。

- **Bashコマンドで `cd` を使用しないでください。** 作業ディレクトリは既に正しく設定されています。ディレクトリを変更せずにコマンドを実行してください。
- **このステップでは編集が禁止されています。** プロジェクトのソースファイルを作成・変更・削除しないでください。コードの読み取り・検索のみ行ってください。レポート出力は後のフェーズで自動的に行われます。


## 判断ルール

- 判断・出力の根拠は、推測ではなく、ファイル・コマンド出力・実コードで確認した事実に限ってください。確認していないことを「たぶんこう」「〜のはず」と書かないでください。確認できないことは「未確認」と明記してください。
- 参照資料に元ファイルの場所が示されている場合は、そのファイルを先頭から末尾まで確認してください。表示が途中で切れた場合は続きを読むものとし、別の checkout、同名ファイル、記憶上の内容で代替しないでください。
- 指摘や編集は、元の要求、変更する観測可能な契約、実在する影響経路から必要性を確認できるものに限ってください。探索中に見つけた無関係な品質改善へ範囲を広げないでください。
- セッションが長くなると、過去に読んだ内容の正確な記憶は劣化します（context rot）。判断・出力の根拠にするファイルは、過去に同じセッションで参照したものであっても、判断直前に再読してください。コマンド出力は、役割と指示がその実行を許す場合だけ再実行し、許さない場合は提供された記録済みの出力を再読してください。「すでに読んだから知っている」「前に確認したから大丈夫」という記憶に依存しないでください。
- 過去のステップ実行・iteration での「修正済み」「確認済み」の記憶を信用せず、対象ファイル・コマンド出力を再確認してから状態を判定してください。



## 実行情報
- Report Directory: ./loop-monitor/project/reports





## User Request
渡された現在裁定を使い、履歴と比較してください。末尾に CURRENT_PROOF、PRIOR_PROOF、CURRENT_TARGETS、PROGRESS を記録してください。CURRENT_TARGETSはAとBのうち現在必要なもの、PROGRESSは改善／停滞／完了のいずれかにしてください。元ファイルのある資料は全文を読み、証拠を照合してください。ソースは変更しないでください。




## Additional User Inputs



## 作業内容
The review and repair loop has repeated 4 times.

Inspect the supplied current review reports, decision record, repair reports, verification reports, and actual code. Determine whether the loop is converging, stalled, or diverging. Do not assume that an absent report type has been generated.

Read past reports from the fixed paths in the supplied history lists and compare their execution identities and order. Pair plans and reports with the same execution identity, keeping current and previous versions distinct. Preserve notices of insufficient history, incomplete executions, and missing reports; do not fill gaps from another execution or a public path.


## Finding Reassessment and Tracking

- Apply only when handling submitted findings. Follow the shared judgment principles for evidence and unknowns while preserving the current stage's decision labels, repair authority, and reporting contract
- When existing IDs are supplied, preserve them and the original acceptance criteria as history, linking current evidence and counterevidence. Do not invent IDs or prior findings for inputs without them or without history
- When reassessing an existing finding, first identify the acceptance criterion's subject, input or precondition, evaluation point, and expected result from the original requirements and prior adjudication, then match current evidence to those same conditions. Do not let the latest review's paraphrase change the subject or evaluation point, or merge another value or usage of the same concept into the original criterion. Establish a separate mandatory basis before adding a different condition
- Separate original acceptance criteria from additional observation methods proposed during re-review. Before keeping a finding open for an added requirement, establish that requirement's necessity from current evidence. Reusing an ID or agreement among reviewers does not establish that necessity
- Premise refutation means that the finding's premise itself was wrong and no repair was needed. The disappearance of the original problem through repair is not a refutation. When a premise is refuted, record why confirmation alone is sufficient and do not require unnecessary code or test changes on the assumption that the finding remains
- Preserve mandatory conditions and establish a real gap before classifying it as a plan, implementation, or evidence defect. Missing optional execution records alone do not justify returning work; record them as unverified


## Scope of inputs used for counterexamples

- Select inputs and states used for successful examples, counterexamples, and boundary values from the range to which the acceptance criterion applies. An input or state is applicable only when records, code, or documentation establish at least one of the following.
  - The requirements, specification, acceptance criteria, or pre-change user-facing contract require handling that kind of input or state. When acceptance criteria identify the target only as a set, such as all registered candidates or all accepted requests, membership in that set alone is not sufficient evidence. Establish which values in the set are applicable using the other items below. When the requirements or an existing contract define the accepted input format itself, such as display names containing any characters or several specified date formats, values of that format are applicable even without records.
  - An existing input source produces or passes that value or format through operations available before the change. User-facing documentation, stored data or records, code, or pre-change tests confirm this. Merely passing values through without validating them does not establish that a format is used. Use those sources of evidence to show which formats among the values passed through are actually used. For formats commonly used at that source, such as names containing spaces or characters from various languages, showing that the format is used is sufficient. The ability to create arbitrary values with the OS or external tools, or to describe a newly constructed operation devised by the evaluator, is not sufficient evidence.
  - The input source also accepts inputs created by someone other than the person operating the program. Examples include imported files, another user's input, and integration responses. In this case, use the range of formats defined by that source's contract or documentation. Do not include values merely because the parser implementation happens to accept them.
  - It arrives from outside a trust boundary where requirements, an existing contract, or an applicable policy require defensive handling. This item and the preceding item also cover exploitable paths through downloaded repository or file contents, network input, integration responses, or another user's input that need no special configuration of the operator's environment. There is no need to show that attack values are commonly used.
  - A record shows that the target program processed that input or state and failed in actual use. Actual use means user operations or operational use, or processing inputs or states established as applicable by another item in this list. Do not include failures caused by values constructed for verification or planning. The input and observed result must be identifiable. Rejecting an input is not a failure when rejection is the correct behavior.
- A type, schema, argument definition, or entry-point validation not rejecting a value does not establish applicability. The ability to create it deliberately does not establish applicability either. The fact that an earlier review, adjudication, verification, or plan raised that input or state or adopted it as an acceptance criterion does not establish it either. Tests or judgments added in response, and records of values constructed for verification or planning, do not establish it either. Records showing inputs and results from actual use do establish it under the items above, even when collected later. The party returning the work based on a counterexample must establish its applicability. Do not carry forward counterexamples from earlier verification or plans without checking their basis.
- A particular state of the operator's own environment variables, shell settings, local configuration files, or similar environment settings alone does not establish applicability either. An assumption that an attacker can already tamper with the operator's environment does not establish applicability when project policy excludes that tampering from protection. Even when external content is involved, a path may be exploitable only if the operator's environment variables, shell settings, or similar settings are in a particular state. Apply the rules above for the operator's environment to such paths as well. Follow the existing threat-model decision rules for threats explicitly excluded from protection.
- Do not decide whether input comes from outside a trust boundary by where it is stored or which process wrote it.
  - Check who can choose the input values and who runs the process reading them with which permissions.
  - Content received from outside and other users' input remain external input after the product stores, copies, or retrieves them.
  - Treat state, settings, and records as inside the boundary when the operator manages them in their own environment and only processes run by that operator with the same permissions read them.
  - Merely assuming that someone shares or distributes that state does not make it external input.
  - When defaults such as ignore rules keep it unshared, merely assuming that someone overrides those defaults does not make it external input either.
  - Treat inputs the product is intended to read from shared sources, such as repository-shared configuration or imported files, as external input.
    - Show that the input is actually shared or distributed using the writing process, sharing defaults (ignore rules and whether synchronization or distribution occurs), user-facing documentation, or the import process.
    - If that cannot be shown, treat it as inside the boundary.
- Do not use a counterexample based on changing a value when the party able to change it can directly produce the same result with the same permissions without changing it.
- Counterexamples assuming concurrency or races are applicable only when operations on the same resource overlap in actual use.
  - Establish that operations overlap through at least one of the following.
    - The product itself runs the processes concurrently.
    - Requirements or documentation specify simultaneous use.
    - Records show that operations overlapped and failed in actual use.
  - Merely assuming that people happen to start their operations at nearly the same time does not establish overlap.
- Choose counts, sizes, and lengths from limits established by requirements, existing contracts, or the input source, or from quantities that source produces in actual use.
  - The ability to construct quantities exceeding technical limits, such as buffers or argument lengths, does not establish applicability.
  - For input whose values can be chosen from outside the trust boundary, quantities that can be sent within the accepted contract are also applicable.
- Treat counterexamples whose applicability cannot be established as follows.
  - Do not use them to mark a repair that satisfies its acceptance criteria as incomplete.
  - Do not use them to judge its plan invalid.
  - Do not add them to acceptance criteria, regression conditions, or plan verification items.
  - Do not require measures against those premises (locks, mutual exclusion, validation against tampering, new limits, etc.) as proposed repairs, acceptance criteria, or plan verification items.
  - If retaining them as concerns, record each in one line as a check that does not change the judgment.
- Do not exclude applicable inputs because they are infrequent.
  - Include the following inputs and states in successful examples and counterexamples as well.
    - Counts or lengths near limits established by requirements, contracts, or the input source
    - Large data that the source actually produces
    - Empty sets actually produced
    - Variations in formats produced by the source
    - Overlapping operations between processes run concurrently by the product itself


# Evidence-Based Judgment

Distinguish requirements, observed facts, proposals, and unknowns when planning, implementing, verifying, and reviewing.

## Principles

| Principle | Criteria |
|-----------|----------|
| Authoritative requirements | Separate original requirements, specifications, and public contracts from plans, reports, and proposals. Repetition does not make a proposal mandatory |
| Evidence in both directions | Inspect both supporting evidence and current code or records that could refute the judgment |
| Real paths | Trace entries to observation points, including existing validation, aborts, and cleanup. Do not justify a defect with a hypothetical path that removes an active guard |
| Effects and success behavior | A guard's existence is insufficient: verify when it prevents prohibited results or side effects and whether required success behavior is preserved |
| Preserve explicit obligations | When requirements specify methods, structure, tests, or documentation, equivalent results do not excuse omission |
| Explicit unknowns | Do not turn absent evidence into either success or a defect. Separate established conclusions from unverified scope |

## Judgment and Work Authority

- When no method is mandated, judge required conditions rather than conformance to a proposal. Current behavior and existing tests do not justify behavior that contradicts requirements
- Distinguish absent records from absent mandatory implementation or verification mechanisms. For a claimed gap, identify its source-backed obligation, the unmet condition, and why existing implementation or verification cannot meet it
- When necessary information is missing, identify the unknown premise and the information needed to check it. Do not establish a cause by speculation or weaken mandatory conditions
- These principles do not change execution or editing authority or stage completion criteria. Implementers must still run required tests and submit required evidence; read-only roles record unverified scope without performing new executions

## Grounds for Missing Tests

- Tie mandatory test additions to an explicit verification obligation, a representative untested condition of new or changed behavior, or regression prevention for a confirmed defect. When relying on new or changed behavior, connect the untested condition to an operation, handoff, or state transition changed in this task. These test gaps remain actionable even when the current implementation has no defect
- Whether existing tests detect a hypothetical code mutation measures their sensitivity; it does not establish an obligation to add that test in the current change. Do not expand acceptance criteria for already verified behavior solely by assuming arbitrary corruption of unchanged internal state
- When claiming an observation point is insufficient, identify which condition of the required behavior remains untested. Proposing observation at a deeper layer, another state copy, or a subsequent operation does not itself establish a gap. If existing observations and implementation paths establish the condition, treat additional observation methods as optional improvements
- Distinguish an untested input or failure condition from an additional observation method for the same condition. A new caller using existing behavior, or internal state being consumed later, does not by itself make all state of that existing behavior a verification obligation for this change. To require another observation for an already exercised condition, identify a contract requiring that observation, a handoff or update rule changed in this task, or a currently established inconsistency


**Fix plan validity:**
- Preserve each finding's ID and source-backed problem, acceptance criteria, and remediation boundary, and recheck its evidence against current code. Treat reviewer-proposed methods as candidates that do not override requirements, specifications, schemas, or public contracts
- Plan findings with the same cause, violated observable condition, and acceptance criteria as one repair rather than splitting them by reported location. Do not merge findings merely because names, types, or files are close, and keep problems separate when their cause or acceptance criteria differ
- Use code and data flow to inspect every existing path needed for the acceptance criteria, from definitions through production, transformation, validation, persistence, restoration, consumers, and externally observable results. Do not stop at a representative location or expand into an unrelated neighboring contract
- When an enum, state transition, input format, candidate order, result limit, or other bounded state affects the problem, make concrete only the values and boundaries within the scope specified in “Scope of inputs used for counterexamples” above. Do not add unsupported values or combinations as coverage requirements
- For each path, state whether it must be edited, migrated or removed, or only verified. When a shared change is sufficient, verify already-correct consumers instead of editing them for symmetry
- When language, runtime, standard-library, or dependency behavior supports the cause or verification, confirm the actual input and result from target code, a type or API specification, or provided recorded results
- Do not expose private definitions, change a public schema or field name, or add a production enumeration API solely to simplify tests or improve naming
- Reconcile repair methods, verification methods, and completion criteria with the requirements, current code, and public contracts. Apply relevant judgment criteria or reference material supplied by the task, and make completion externally observable
- Verification must traverse the affected contract path and observe a point that fails while the problem remains. Verify static conditions by comparing the current code, types, and schemas
- Revise a plan when changing it can resolve a missing or contradictory cause, remediation boundary, affected path, method, acceptance criterion, or verification method. Distinguish such plan defects from implementation or evidence that is merely incomplete against an otherwise valid plan


First establish the observation point from report chronology. Determine whether verification or review ran after the latest repair. If neither ran, use the repair report's completion conditions and remaining work to distinguish waiting for verification from unfinished implementation.

Use producer start and completion orders in the current report execution records to check whether verification or review started after the latest repair completed. Compare the actual report producers even when they share a parent call. If orders are unavailable or executions overlap, mark chronology as unverified rather than inferring it from file names, modification times, or identifiers.

Across iterations, compare acceptance criteria newly satisfied, the same root causes that remain, code and evidence that changed, and newly confirmed structural or contract problems. Do not infer progress from counts or identifier changes alone; verify that implementation or evidence materially changed.

Treat the loop as stalled or diverging when the same cause and evidence repeat, post-repair reports disagree with current code, or structural problems continue to appear without reducing the uninspected area. When required repairs are progressing and the remaining work is concrete and executable, the loop may still be converging even though it is not complete.

Require replanning only when evidence shows that the plan's assumptions, repair boundary, method, or verification capability are insufficient or inconsistent and a plan change can address the problem. Implementation or evidence gaps alone do not justify replanning.

Choose the supplied outcome that matches the current evidence. Do not report convergence while completion conditions remain unmet. When evidence shows that repeating the same review or repair cannot resolve the loop, choose the outcome that stops that repetition.


## 宣言された成果物入力
### fix: fix-report.md
現在の修正報告。以下の背景は結論ではありません。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背景の調査記録。
背

[Report truncated; full version: `./loop-monitor/project/reports/.takt-report-internal/executions/versions/57175643-365b-4676-a8aa-5404094ebcc5/fix-report.md`]

### fix: fix-report.md (history)
History: 1 / 2 completed previous executions
- execution=5d939b6f-cbe7-402c-9e5c-722c87ffc203/37c90273-936d-49c1-8fc7-9cb3c8ef5559 order=1 completion_order=2 status=completed producer=fix path=`./loop-monitor/project/reports/.takt-report-internal/executions/versions/61bd966a-0738-4fe2-bd62-51c465a64d48/fix-report.md`

## 現在レポートの実行記録
- fix: fix-report.md; execution=5d939b6f-cbe7-402c-9e5c-722c87ffc203/151d3197-a014-4269-adf3-ab5b9eb2c8ba; order=3; completion_order=4; producer execution=5d939b6f-cbe7-402c-9e5c-722c87ffc203/151d3197-a014-4269-adf3-ab5b9eb2c8ba; producer start=3; producer completion=4



