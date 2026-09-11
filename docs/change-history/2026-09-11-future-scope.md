# Guru layout evidence clarification

The 05:42 layout record below is historical, not the latest layout. The later 07:07:06 UTC run expanded coverage to sixteen views at 1366×768, 1440×900, 1920×1080 and 800×1000 plus two resize checks. The newest existing report inspected during documentation cleanup was run `2026-09-11T09-41-39-934Z-hXdVbm`, with the same eighteen layout records and screenshots, `fixture: "TEST ONLY"`, `liveFetch: false`, `interactionsPassed: true`, and empty browser-error, external-request and forbidden-call lists. No new layout run was performed during this cleanup.

The [maintained Guru layout test](../../tests/ui/guru-layout.test.js) checks the production interface with offline provider fixtures. The current [controller](../../ui/gui/guru.js) measures the primary table against its host and reserves pagination space, instead of imposing a fixed 640px cap. The [styles](../../ui/gui/guru.css) retain nine overview columns and a 12px minimum. The inspected report records nine visible overview rows at 1366×768, no clipped cells and 12px minimum text across its views. This is layout and interaction evidence, not live-feed, native Electron or financial-performance validation. Local raw reports remain outside the shared repository.

Maintained Node tests now live in [tests/ui](../../tests/ui), with shared helpers under [tests/ui/helpers](../../tests/ui/helpers). Optional workstation verifiers and recorders live under Git-ignored tools/local. Historical command strings below retain the paths used at those earlier stages; use the current commands in the [developer guide](../02-developer-guide.md) for new runs.

# Documentation cleanup and event-result correction

The language policy is English for all documentation, README, static UI and video text. Only the personal root requirements document is exempt. Earlier Korean-document policies in this record are superseded. User inputs, provider responses and historical evidence files remain unchanged.

Temporary storage diagnostics and the obsolete one-off checkpoint script were removed. The reusable synthetic CLI harness moved to [tests/evaluate_research.py](../../tests/evaluate_research.py); its inputs are under [tests/fixtures](../../tests/fixtures). The video renderer remains a production utility. Removing diagnostics does not resolve the known intermittent storage failure.

Technical signals display **Hold** for the backend's unchanged `Neutral` state, including accessible labels, counts and explanations. The three directional votes remain SMA, MACD and RSI; the other indicator readings are not additional votes.

The saved-market integration check exposed a real UI defect: choosing reviewed Backtest inputs left the event-source identity stale, so completion cleared an otherwise valid result. Identity now synchronizes when inputs change; stale replies still cannot replace newer inputs. Regression checks cover completion, export, navigation and changes during pending requests.

- Assets/Event studies regression: 14 passed.
- [Saved-market integration report](../../output/future-scope-verification/runs/2026-09-11T09-38-26-127Z-VgjDVw/report.json): 16 passed, with independent and reviewed event studies, exact public-CLI result equality, and unchanged saved data. The evaluation contract is fixed before calculations against the current archive, never selected for performance. Guru remains a test-only response in this verifier.
- Full Node/UI regression at this stage: 235 tests, 233 passed, 2 optional skips, zero failures. It includes production-browser checks, not new native Electron or live-model acceptance.
- The first integration attempt found the required Python environment missing. It was restored with locked development dependencies without replacing the existing separate environment. Earlier failed reports were preserved, including the result-clearing reproduction.

Remaining work: intermittent Windows synthetic-run persistence failure; native Electron and fresh-install/user acceptance; broader real-model quality evaluation; and deferred English video recapture/render. Date-bounded Assets downloads are already implemented, not an outstanding one-year-only limitation. Multi-currency, broader reference strategy coverage, licensing and historical-data completeness remain separate scope limitations.

# 2026-09-11 Research expansion scope

This is a **historical record of successive implementation and verification stages**, not a fresh test report. Counts, layouts, failures and artifact paths belong to the stage that recorded them. Current behavior is described in the [architecture](../03-architecture.md), [user guide](../01-user-guide.md) and [developer guide](../02-developer-guide.md).

Later behavior supersedes several policies below: chat now appears only in Markets; Event studies defaults to an independent manual condition, with reviewed Backtest entry/dates as an optional source; Swarm now includes scripted SPY rule cards and sample signals, not evaluated market rules. Earlier reports do not verify those later additions. The former Korean-documentation policy is also superseded by English shared documentation. No new runtime verification is asserted by this translation.

## Performance chart consolidation and font sizing

Result charts previously scaled a fixed SVG coordinate system with screen width. They were changed to measured width and fixed height. During execution, CAGR (annualized compound growth) and MDD (maximum drawdown) share one percentage axis, using metric colors and distinct strategy/benchmark line styles. Completed results combine final backend CAGR/MDD values with NAV (net asset value) and daily drawdown on a common time axis in one card. Values, missing-data handling and financial calculations were unchanged.

[Chart checks](../../tests/ui/performance-chart.test.js) used offline mock responses to verify effective font sizes after SVG screen transforms, resizing, raw values, missing data and hide/restore behavior at 800, 1366 and 1920px. The full Node/UI regression recorded at this stage was **213 passed, 0 failed, 2 skipped**. There were no new external-price or model calls, Python calculation changes or native checks. Counts and layouts below describe their own historical stages.

## Compact Guru layout and Markets-only chat

This stage superseded the earlier **hide chat only in Swarm** policy. Earlier text, reports and failures remain historical evidence; their Node totals are not this stage's regression result.

- **Chat appears only in Markets.** Requests send the selected asset's data from archive start through the selected timestamp, not Backtest, correlation, event-study, Guru or Swarm context. Other workspaces reclaim the desktop sidebar and narrow-window bottom dock. The same DOM nodes, history and unsent draft are preserved and shown again on return to Markets. Topbar **Settings** is the sole setup entry, accessible everywhere, containing connection checks and model selection. Opening it makes no request.
- **Guru is table-first.** Titles, tabs, filters and Overview summaries/counts were compacted while retaining a short estimate/delayed-13F warning. Full disclosures expand under **Provider notes and data limitations**. Detail places holdings first, with filing summaries and secondary estimated-performance/weight charts below.
- The [05:42:52 UTC Guru layout report](../../output/guru-verification/layout-runs/2026-09-11T05-42-52-136Z-myaW0I/report.json) is **TEST ONLY**, with `liveFetch:false`. Across Overview, popular, changes and detail at 1366×768, 1440×900 and 800×1000, **all 12 layouts placed the first data row's top above the viewport midpoint**, with the full row inside the viewport. Checks covered filters, search, quarters, sorting, keyboard input, retained selections after refresh and expandable notes. `interactionsPassed:true`; there were no external requests, model calls or browser errors. This is not real-reference-data or new financial-performance verification.
- Markets height overflow originated in absolutely positioned `.sr-only` children inside an unpositioned `.technical-missing` parent. Adding `position: relative` to the parent contained their positioning. The agent actually ran the [workspace layout checks](../../tests/ui/workspace-layout.test.js): **4 passed**, also passing in this stage's full Node/UI regression. Test data covered Markets, Backtest, all Research tabs and Swarm at 1440×1000, 800×1000 and 1440×650, including chat-state preservation, reclaimed space and Settings access.
- [Indicator display checks](../../tests/ui/indicator-visuals.test.js) also recorded **4 passed** in that full suite. The 13 Reading rows' categorical icons are separate from the three Python default-signal votes; they are not 13 Buy/Sell votes.

**This stage completed the full Node/UI command `node --test --test-concurrency=1 ui/*.test.js`.** Exit code 0; **214 tests: 212 passed, 0 failed, 2 skipped**, in 111660ms. Skips were the opt-in [live Guru smoke](../../tests/ui/guru-service.test.js) and [legacy isolated Swarm browser check](../../tests/ui/swarm.test.js); [production Swarm integration checks](../../tests/ui/swarm-demo.test.js) actually ran and passed. This is one complete run, not a sum of module counts. No new native Electron, financial, real-model, external-feed or full Python regression verification was performed. Earlier evidence retains its original dates and limits.

## Implementation and verification at the earlier redesign stage

**Historical status: browser integration and Node regression passed for standalone Backtest, automatic Guru and top-level Quant Swarm.** These redesign records are separate from pre-redesign evidence. Browser success did not establish new native Electron or real-model verification, or full product acceptance.

- **Backtest** became an independent top-level workspace outside Markets. Single asset, Static allocation and Dynamic allocation shared one rules form: description → **Generate rules** → readable **Buy / Sell / Hold** summary → **Review rules & settings** → **Run backtest**. Copilot proposed bounded declarative rules, not executable code. Description/source changes invalidated proposals; settings changes required another review. **Build rules manually** was an explicit secondary path, with active JSON disabling simple inputs.
- **At this earlier stage**, explanation-only chat was hidden only in Swarm and remained visible in other workspaces, preserving conversations and drafts. **Research / Event studies then required** reviewed Backtest entry criteria and dates, excluding exits and costs. It was not an independent natural-language event-specification generator. Mandatory Backtest reuse and Swarm-only chat hiding are historical, not current requirements.
- **Research / Guru** replaced manual upload with automatic server-mediated reference retrieval. **Quant Swarm** became a separate top-level Beta demonstration, with boundaries documented below.

At that time, the app, [root README](../../README.md) and video used English while documentation used Korean declarative prose. **That documentation-language policy has since been superseded.** Arbitrary user questions and provider responses are still not forcibly translated. Video production remained deferred; existing Korean MP4s, captures and provenance were preserved. English video sources were updated but not newly rendered.

## Full-viewport Quant Swarm demo and its verification

At this stage, Swarm alone hid chat to use the full width. Chat DOM nodes were neither deleted nor recreated, preserving history and drafts for other workspaces. Leaving the workspace paused playback. The change added a purple Beta background and eight local Koboyo people SVGs. The [icon guide](../../ui/gui/avatars/README.md) retains original URLs and licenses. These are fixed decorative app assets, not an icon library, picker or redistribution collection. Runtime external icon requests were zero. The later Markets-only chat policy supersedes this stage's restoration behavior.

Header controls, current phase, an eight-agent arena, auto-follow inspector, latest three messages, top-four candidate comparison, all twelve lineage nodes and the current change's cause were arranged on one screen. Lineage explains parent strategies and derivation. The existing public scenario remained 60 seconds, six chapters, four message-driven pivots and twelve candidates. All performance, curves and scores were fictional; Swarm controls called no API, model or backtest.

The [04:47:40 UTC Swarm report](../../output/swarm-demo-verification/runs/2026-09-11T04-47-40-525Z-hNDbnz/report.json) records **PASS: 19 checks and 28 screenshots**. Chromium exercised unmodified `startGUI` HTTP assets and the production UI. At each of **1366×768, 1440×900, 1920×1080 and 800×1000**, it sampled 0–60 seconds every 0.25 seconds: 241 samples per viewport, **964 total**. The eight agents did not overlap, and complete message packets, controls and primary content fit without scrolling. Checks covered play, pause, restart, next event, speed, timeline, keyboard, inspector, chat hiding and draft restoration. The scrolling fallback for phones at widths of 600px or less was outside this no-scroll verification scope.

Initial `market.show` explicitly returned unavailable in the verification environment; no financial data was fabricated. Swarm interaction caused no API calls, external requests, Guru/SDK calls or browser errors. This was **demo layout and interaction verification**, not a new financial backtest, real-model check or native Electron run. Python code was unchanged and the full Python regression was not rerun.

The user-supplied full Node result at this stage was `node --test --test-concurrency=1 ui/*.test.js`: **197 tests, 195 passed, 0 failed, 2 skipped**. Skips were [live Guru smoke](../../tests/ui/guru-service.test.js) and the [legacy isolated opt-in Swarm browser check](../../tests/ui/swarm.test.js). The latter was replaced in the default execution path by the [production startGUI Swarm check](../../tests/ui/swarm-demo.test.js). This was not a new test execution during that documentation update.

Earlier reports, failures and screenshots were retained. The 03:46 persistent-chat/internal-scroll descriptions and Node totals below belong to their earlier stage; this full-viewport change superseded that Swarm layout, and Markets-only chat later superseded the Swarm-only policy. A previous 2px clipping at the lineage bottom was corrected with spacing; stable packet widths were checked against boundaries. Dates of financial, Guru, native and model evidence were not refreshed.

## Redesign verification evidence and layout corrections

This section records the **03:46 redesign stage**, not the current Swarm layout or latest regression totals.

### Real Guru reference API and production interface

The [2026-09-11 03:46:30 UTC Guru report](../../output/guru-verification/runs/2026-09-11T03-46-30-460Z-0rw8yQ/report.json) records **23 passed, 0 failed**. Actual Chromium interaction sent 11 real GETs through the production UI and Node adapter to fixed reference endpoints. One of 12 responses was a cache hit; SDK calls and direct renderer-to-external requests were zero. All default-list rows and percentage units were compared. Of 87 total funds, 79 had both `active` and `show_in_default` true. The test did not require a permanently fixed fund count.

ARK's then-current holdings quarter, 2026-06-30, and historical quarter, 2026-03-31, were selected. Responses matched 197 holdings rows (190 positions, 7 sold rows) and 209 rows (181 positions, 28 sold rows), respectively. Both responses covered performance from 2020-12-31 through 2026-06-30. The display retained the fact that historical holdings can include later performance. Provider value 23.811… meant approximately 23.81%, not a value multiplied by 100. Checks also covered popular holdings/buys/sells, quarter/index-inclusion/fund/change filters, provenance and cache display.

Guru views and Swarm were checked at 1440×1000 and 800×1000, including actual Swarm controls. Swarm remained a request-free concept demonstration. All 17 saved-price files and 13 checked production-source files were identical before and after the run. The browser and server were cleaned up; existing native processes were not terminated. This verified **reference-response retrieval and display, not SEC-original authenticity, actual fund returns or independent performance calculations**. `source.independentlyVerified` remained false.

### Saved Yahoo browser and public CLI parity

The [2026-09-11 03:46:39 UTC integration report](../../output/future-scope-verification/runs/2026-09-11T03-46-39-342Z-dLSKdZ/report.json) records **15 passed, 0 failed**. It reused archive `6e631bd3-c254-4e9d-981b-ce3324fdeea9`: SPY, QQQ and IWM, with 251 observed sessions from 2025-09-10 through 2026-09-09. Initial cash of 100000 USD, fees of 5bp, slippage of 10bp and compound criteria were fixed before execution. Fixed allocation used 20-session intervals; momentum used monthly N=1, lookback 20 and the top two assets. The purpose was verification, not performance optimization.

Actual UI interactions checked daily/weekly/monthly correlation, single/fixed/momentum backtests, 1/5/20-session event outcomes and JSON export. **Entire results** for every relevant calculation were compared with the ordinary public CLI using identical specifications. Each backtest's 502 actual progress records, strategy/benchmark order, day-zero CAGR `null`, interim/final metrics and chart hide/reopen behavior were checked. An observation wrapper delayed only delivery of original NDJSON rows by 12ms; it did not create or modify values, rows or ordering. The ordinary CLI retained one final result.

Automatic Guru in this test used **TEST FIXTURE ONLY — mock response-shaped data, not real public holdings**, injected into the production adapter. Live Guru lookups were zero; this must not be confused with the separate live report above. Swarm message delivery, pivots, pause and reset made no API/model calls. All 17 saved-price files retained their hashes, with no new price collection, SDK status checks or model calls. `realModelVerified`, `naturalLanguageVerified`, `realGuruHoldingsVerified` and `fullProductPass` were all false in this report.

### Layout failures and verification after the fix

The [03:36:54 UTC failure report](../../output/guru-verification/runs/2026-09-11T03-36-54-067Z-FCCNlz/report.json) preserves **seven layout failures**. At 800×1000, Guru document heights grew to 1910px for Overview, 2838px for detail/historical detail, 2016px for popular and 2122px for changes, pushing the then-persistent chat below the viewport. Swarm document height reached 2809px at 1440px width and 3247px at 800px. Successful data responses did not turn these interface failures into passes.

Production [host CSS](../../ui/gui/style.css) was changed to a viewport-height shell with internal workspace scrolling, retaining chat/input visibility while allowing access to long tables and details. The fix did not weaken failure criteria or hide the issue with test-only CSS. In the 03:46 Guru rerun, every checked document stayed within the 1000px viewport height. Earlier failure reports, screenshots, responses and other artifacts were neither edited nor deleted. Automated geometry checks and captures remain distinct from user visual evaluation and acceptance.

A separate [viewport regression check](../../tests/ui/workspace-layout.test.js) passed at **1440×1000, 800×1000 and 1440×650**, using production HTML, CSS, controllers and authenticated local transport. At that historical stage, it verified persistent chat/input and top controls within the viewport, plus internal-scroll access to the final Guru page/holdings rows and Backtest, Research, Markets and Swarm details. Financial inputs were explicitly offline mocks, not evidence of real prices or filings. Persistent chat was subsequently superseded.

### Regression results and evidence not refreshed

- The user-supplied full Node result at that stage was `node --test --test-concurrency=1 ui/*.test.js`: **195 passed, 0 failed, 1 skipped**. The skipped [live-service smoke](../../tests/ui/guru-service.test.js) required an explicit `--live` flag. Actual external retrieval was covered by the separate live Guru verification above. This was not a sum of module pass counts.
- The last successful native Electron report remained the **pre-redesign** report below. A later launch was blocked by an existing user-owned ITT process; that process was not forcibly terminated. Chromium success did not refresh the native verification date.
- There were no new real SDK model calls. Only the two calls on the same Korean example and their offline correction remained historical evidence. Browser verification did not recheck the model's natural-language interpretation.
- The redesign changed Node/UI code, so the full Python regression was not rerun. **1275 passed, 8 skipped** remained a historical baseline, separate from the newer public-CLI integration checks. The intermittent storage error was not declared fixed.
- English video sources were not newly rendered. Existing media, captures and provenance were preserved; video production remained deferred, reference-feature gaps remained, and user acceptance was unconfirmed.

## Reference features and local implementation differences

easyinvesting's five routes were inspected as functional references. Their returns and dataset sizes were not this app's results. The requested scope was neither reduced nor declared entirely complete. The table describes the implementation **at this historical stage**, including its then-mandatory Backtest reuse for Event studies.

| Reference route | Observed reference feature | Local implementation then and remaining differences |
|---|---|---|
| [Correlation](https://easyinvesting.app/#/correlation) | Pearson correlation matrix with asset, period, return frequency and base-currency selection. Pearson correlation describes how returns move together; it does not establish causation. | Daily/weekly/monthly returns for 2–10 saved USD assets only; not 30 assets, multi-currency support or reproduction of the reference dataset. |
| [Static allocation](https://easyinvesting.app/#/allocation) | Examples such as Permanent Portfolio, All Weather and 60/40, with weights, costs and rebalancing; analysis advertised from 2000 onward. | Fixed weights and scheduled rebalancing for actually saved assets, including equal-weight and SPY/QQQ/IWM examples. Missing assets were not automatically fetched or substituted. This did not reproduce long histories, every example strategy, currency conversion or full strategy management. |
| [Dynamic allocation](https://easyinvesting.app/#/dynamic) | Comparison of allocations, CAGR and MDD for BAA, VAA, HAA, dual momentum and other strategies. | Simple momentum equally allocated the budget among the top N eligible assets with positive trailing returns. Monthly decisions followed the local code contract; no exact BAA-family reproduction, optimization or reference performance was provided. |
| [Vibe](https://easyinvesting.app/#/vibe) | Natural-language questions connected to trigger analysis. | Natural-language rule generation lived in Backtest; Research / Event studies then reused reviewed entry criteria and dates for retrospective statistics. Users supplied the target and horizons. Independent generation of a complete event specification from a question remained unimplemented. The later manual-independent default is not evidence of natural-language event generation. |
| [Guru](https://easyinvesting.app/#/guru) | 13F-based estimated performance for a default fund list, details, popular assets and changes. | Fixed public-API retrieval, Overview/detail/popular holdings/buys/sells/changes, filters and filing status were implemented. At verification, 79 of 87 funds had both `active` and `show_in_default` true. This displayed provider estimates, not actual fund returns, SEC verification, independent performance reconstruction or confirmed usage rights. |

Collection **at this stage** was limited to `range=1y`, `interval=1d` and USD. Calculations used actual saved sessions without shifting dates or synthesizing long histories. Explicit download date bounds were introduced later; the old one-year limit is not the current collection contract. See the [developer guide](../02-developer-guide.md) for calculations and the [user guide](../01-user-guide.md) for current workflows.

## Natural-language research workflow reference

The [agent_quant_stock reference implementation](https://github.com/kimtth/agent-quant-stock-invest/tree/main/agent_framework) follows data acquisition → REPL execution/output validation of generated Python signal scripts → backtest → visualization/summary. Its [workflow](https://github.com/kimtth/agent-quant-stock-invest/blob/main/agent_framework/workflow.py) and [development REPL](https://github.com/kimtth/agent-quant-stock-invest/blob/main/agent_framework/research_repl.py) informed the design, but generated-code execution was not introduced. The reference itself states that its REPL is not a security boundary.

ITT instead follows Copilot → declarative rule-tree validation → user specification review → Python signals/backtest. An AST is a data structure representing conditions as a tree, not Python source. Depth, node count and computation are bounded; only allowlisted operations are evaluated. The real model's single Korean example is documented below, not presented as general model-quality validation.

## Connected features and boundaries at this stage

- [Progress metrics](../../src/itt/progress.py) used identical interim/final NAV, CAGR and MDD definitions. Each simulator applied fees in its own shared ledger; the browser did not calculate separate performance.
- Only explicit `market.backtest.stream` and `market.portfolio.stream` RPC calls emitted `{id,event:'progress',data}`. Request IDs connected progress and final responses. Existing RPC and CLI calls retained one result.
- HTTP `POST /api/stream` applied the ordinary API's token/origin checks and accepted ordinary `market.backtest`/`market.portfolio` names to select RPC streams. Actual progress records, final results and entire ordinary CLI results were compared. Errors or disconnection before a final response could not turn partial output into success.
- `market.correlation`/`market.trigger` RPC arguments were `store_path` and `spec`. Python `market.guru` remained a manual-filing compatibility path accepting only `spec`, with `schema guru` and `market guru --spec PATH` retained. Automatic Node `guru.*` did not call that Python path.
- The [Research controller](../../ui/gui/research.js) connected top-level routing, Research tabs, progress and event analysis. Backtest's **Hide progress charts / Show progress charts** hid charts but retained the progress bar. **At this stage**, event studies used reviewed entry criteria and dates only, without exits or Backtest costs. Independent manual conditions were added later.
- Desktop export was limited to user-initiated same-origin JSON blobs from the app-owned page, with known positive size at most 8MiB, allowed result filenames and JSON MIME. It used the native save dialog; automatic downloads, external navigation and popups remained blocked. Filename/MIME checks did not authenticate JSON contents. See the [developer guide](../02-developer-guide.md).
- [Quant Swarm](../../ui/gui/swarm.js) was a top-level Beta concept simulation retaining 60 seconds, eight agents, six chapters, four message-driven pivots and twelve candidates. The full-viewport stage above added local people icons and hid chat. All performance, curves and scores were fictional, with no API/model/backtest calls or actual optimization. Later scripted SPY rule examples are also illustrations, not calculated returns.

### Automatic Guru data and security boundaries

The [Node adapter](../../ui/guru-service.js) sent fixed GETs to funds, quarters, fund/{CIK}/holdings, popular, buys, sells and recent-changes under `https://easyinvesting.app/api/guru/*`. Separate checks confirmed unauthenticated public GET access and response contracts, not the provider's financial calculations. The [view module](../../ui/gui/guru.js) loaded on opening Guru, without hidden startup requests. There were no frontend uploads, direct external requests or separate performance calculations.

The server validated allowlisted methods, listed ten-digit CIKs, quarters, filters, limits and responses. Defaults were 15 seconds and 8MiB per response, blocked redirects/credential forwarding, a five-minute cache bounded to 64 entries/32MiB, eight concurrent requests and same-URL in-flight sharing. Errors, expiry and failed refreshes did not fall back to stale cache or invented data. Refresh did not trigger provider collection; automatic retries were absent. These bounds were not a comprehensive security audit or upstream-service guarantee.

Returns, weights and changes were already percentage points: 23.8 meant 23.8%, without multiplying by 100. YTD meant performance through the return end date in that end date's year. Holdings quarter and performance start/end dates stayed separate; missing values, filing status, freshness, provenance and cache age were retained. Historical holdings responses could include later performance. 13F-based estimates can omit intra-quarter trades, some securities and parts of total assets; they are not actual fund returns or SEC-certified performance. Public access is not redistribution/commercial-use permission. Collection schedule, SLA, independent performance calculations and licensing remained unconfirmed.

Initial module reports recorded 18 service, 11 Guru UI and 10 Swarm passes in the [service tests](../../tests/ui/guru-service.test.js), [UI tests](../../tests/ui/guru-ui.test.js) and [scenario tests](../../tests/ui/swarm.test.js), respectively. These were individual historical results. Full Node suite results are recorded separately by stage above and must not be obtained by summing these counts.

## Pre-redesign live verification history

### Saved data and browser integration

The [earlier integration report](../../output/future-scope-verification/runs/2026-09-11T01-55-16-354Z-7DYj2w/report.json) records **15 passing checks** from 2026-09-11 01:55 UTC. It used archive `6e631bd3-c254-4e9d-981b-ce3324fdeea9`: SPY, QQQ and IWM, 251 sessions from 2025-09-10 through 2026-09-09. Initial cash of 100000 USD, fees of 5bp, slippage of 10bp and criteria were fixed beforehand; this was not a search for profitable rules.

Actual browser actions checked daily/weekly/monthly correlation, single/fixed/momentum backtests, chart hide/reopen, Vibe's 1/5/20-session outcomes and JSON export. Entire results and ordered real streams were compared with the public CLI. The test delayed only original NDJSON delivery to observe progress; it did not generate or modify values or ordering. All 17 saved-data files retained their hashes, with no new collection or model calls.

Guru import then used **TEST FIXTURE ONLY** data to check manual UI/protocol/CLI parity. It did not verify current automatic Guru or real filing holdings. The old Swarm mock made no API calls during start, pause and reset, but that was not integration evidence for the later independent module. Narrow layouts and shutdown cleanup were checked; `fullProductPass` and `realGuruHoldingsVerified` remained false.

### Actual Electron and download policy

The [native report](../../output/future-desktop-verification/runs/2026-09-11T01-53-49-497Z-y5HrBq/report.json) passed using the installed Electron runtime. It checked whole-result CLI parity for correlation; JSON export completion/cancellation; actual monthly dynamic-allocation progress, chart hide/reopen and final-result parity; blocked automatic downloads, external navigation and popups; isolation settings; and shutdown cleanup. The archive was unchanged and there were no SDK calls.

The production native-save-dialog setting was verified, but the test supplied the destination in a listener. It did not directly operate the OS dialog. Guru was checked only in its empty state, without importing real filings. This report did not establish full product acceptance or real-model verification.

### Real Copilot calls and correction of an invalid failure verdict

The [session summary](../../output/live-criteria-verification/session-summary.json) records **two actual GitHub Copilot `gpt-5.4-mini` rule-generation requests**, with zero automatic retries. Both used the same single Korean case. SMA17, RSI9, AND entry, OR exit and current-value comparisons rather than crossings were semantically correct. The second call also verified preserved editor text, a reviewed specification normalizing only omitted `lag:0`, actual streams, displayed metrics, downloads and **whole-result** public CLI parity.

The original verifier incorrectly required an undocumented `supported:true` field and marked the result failed. This was a verifier-expectation error, not a product bug. The [2026-09-11 01:48 UTC offline revalidation](../../output/live-criteria-verification/revalidations/2026-09-11T01-48-12-158Z-10YqG3/report.json) corrected the checker and passed by comparing the two existing responses, saved evidence and the then-current read-only public CLI. No field was added to the product. New inference, status checks and GUI executions were all zero. Omitted `supported` was accepted; explicit `false` remained rejected.

Original failure reports and the session summary's initial status were preserved; the correction was appended under `corrections`. GUI checks not completed in the first run remained incomplete. This was neither a new live run nor two distinct examples, and it did not establish general Korean, multilingual or investment-analysis quality.

## Remaining differences and known issues

- Automatic Guru reference retrieval and the recorded browser integration checks were complete at their stated stages. Multi-currency support, long histories, 30 assets, the reference's full named-strategy catalog, independent fund-performance reconstruction, usage rights and complete natural-language event-specification generation remained gaps. No blanket reference-parity claim was made.
- Updated native Electron and new real-model verification remained outstanding. The [session summary's Python regression record](../../output/live-criteria-verification/session-summary.json) predates the redesign and must not be combined with newer Node results to claim a full product pass.
- Intermittent `unable to save run` errors recurred in the unchanged Windows path in [../../src/itt/store.py](../../src/itt/store.py). A rename-time `PermissionError` had been observed, but its cause and fix remained unconfirmed. Later green tests do not prove repair or nonrecurrence.
- Fresh-environment installation, double-click launch and user acceptance remain separate from the recorded integration checks. Saved prices do not guarantee historical point-in-time availability, survivorship-bias removal, dividend total returns or verified data rights.