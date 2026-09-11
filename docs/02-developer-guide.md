# Developer guide

This guide covers setup, the public CLI, calculation and transport contracts, and verification practices. See the [user guide](01-user-guide.md) for screen workflows and [architecture](03-architecture.md) for component responsibilities.

**Evidence boundary:** the [change history](change-history/2026-09-11-future-scope.md) records earlier offline Guru layout and Markets-only chat checks, full Node/UI regression runs, and production Swarm integration checks. Saved-price HTTP/RPC, UI and public CLI parity, and real Guru reference responses are also historical evidence. This documentation update does not rerun or certify the current full suite, native Electron, models, external feeds, financial calculations or Python regression tests. The synthetic research engine remains a separate development path for accounting tests with controlled inputs.

Top-level menus are **Markets / Backtest / Research / Quant Swarm**. Allocation modes belong in Backtest; **Correlation / Event studies / Guru** belong in Research. Shared documentation, app text, the [root README](../README.md) and video sources use English. Do not forcibly translate arbitrary user input or provider responses.

## Development setup and launch

On Windows PowerShell, use Node 24 or later, Python 3.13 or later, pnpm and uv.

When environment setup is within the task scope, run these commands in order from the repository root. Confirm each step succeeds before continuing.

```powershell
$env:UV_PROJECT_ENVIRONMENT = '.venv'
uv sync --locked --group dev
pnpm --dir ui install --frozen-lockfile --ignore-scripts
node ui/node_modules/electron/install.js
```

The first two lines prepare the repository's sole Python environment, `.venv`, including development tools from [pyproject.toml](../pyproject.toml). It replaces the former rewrite environment; historical reports retain their original paths. If a running editor tool locks an executable, leave that process intact and complete synchronization after its owner releases it. The remaining commands install the locked packages from [ui/package.json](../ui/package.json) and the Electron executable.

`pnpm start` launches the desktop; `pnpm start:web` launches the local web UI. This is a repository-backed application requiring its dedicated Python environment, not a standalone installer. The backend does not automatically switch to another Python. Double-click launch through [Start-ITT.cmd](../Start-ITT.cmd) and the full install-to-shutdown flow on a fresh environment require separate verification.

**Do not install anything for a lookup-only request.** Stop if the prepared environment is missing or uncertain. Even `uv run --locked` can change an environment, so it is not a read-only substitute.

### Utility cleanup

Temporary storage diagnostics and the obsolete one-off checkpoint script have been removed. The reusable [synthetic CLI evaluation harness](../tests/evaluate_research.py) lives with the tests and uses [test fixtures](../tests/fixtures). UI tests live in [tests/ui](../tests/ui), with reusable fixtures and browser checks in [tests/ui/helpers](../tests/ui/helpers). The [video renderer](../tools/render_introduction.py) remains a shared production utility; optional workstation capture and verification scripts are excluded from Git under tools/local. Historical reports, backups and media remain preserved; this cleanup does not fix the intermittent storage error or render a new video.

## Public CLI

The CLI calls Python services without the UI. From the repository root, append an explicit command to `./.venv/Scripts/python.exe -m itt.cli` (or `./.venv/bin/python -m itt.cli` on POSIX). There is no extra `cli` subcommand or default action when the command is omitted.

Square brackets mark optional arguments. Replace `PATH`, `DATA`, `SPEC` and `ID` with actual paths or values. `--spec PATH` takes a readable JSON file, not inline JSON. A specification fixes the data, rules, dates and costs to evaluate.

### Inspect capabilities and schemas

| Command | Purpose |
|---|---|
| `capabilities` | Report Python features, not Node Copilot readiness. |
| `schema criteria` / `schema portfolio` | Print single-asset and allocation specification schemas. |
| `schema correlation` / `schema trigger` | Print correlation and retrospective event-study schemas. |
| `schema guru` | Print the manual filing-analysis schema. |
| `schema dataset` / `schema spec` | Print synthetic dataset and research schemas. |

`schema guru` and `market guru --spec PATH` are manual-filing compatibility commands retained in [cli.py](../src/itt/cli.py). This Python path analyzes the input file without a Yahoo store or `--store`. The automatic Guru UI uses the separate Node `guru.*` reference API described below.

### Read and collect market data

| Command | Purpose |
|---|---|
| `market show [--store PATH]` | Validate and read the latest saved archive. There are no symbol, date or archive-ID selectors. |
| `market fetch SYMBOL [SYMBOL …] [--start YYYY-MM-DD --end YYYY-MM-DD] [--store PATH]` | Collect 1–10 unique uppercase symbols into a new archive for an inclusive date range. Omitting both dates retains the legacy one-year request. |
| `market backtest --spec PATH [--store PATH]` | Calculate a single-asset price-return backtest from criteria signals. |
| `market portfolio --spec PATH [--store PATH]` | Calculate fixed-weight or momentum allocation with the same criteria evaluator. |
| `market correlation --spec PATH [--store PATH]` | Calculate a Pearson matrix of daily, weekly or monthly price returns. |
| `market trigger --spec PATH [--store PATH]` | Calculate retrospective target-asset returns after condition hits. |
| `market guru --spec PATH` | Analyze holdings, common securities and quantity changes in user-normalized filings. |

The default market store is `.itt/market`. Collection accepts symbols matching `[A-Z][A-Z0-9.-]{0,9}`, uses `interval=1d`, and accepts USD only. A valid symbol or date range does not guarantee provider coverage. Failed reads never trigger collection, another archive or substitute assets. Analysis results are returned, not saved as synthetic research bundles.

### Explicit download date contract

Append, for example, `market fetch SPY QQQ IWM MSFT --start 2021-09-11 --end 2026-09-11` to the public CLI prefix to request both endpoints inclusively. `start` and `end` must both be strict `YYYY-MM-DD` strings representing real calendar dates. `start <= end` permits a single-day request. An end date of `9999-12-31` is rejected because the following day must be representable. Five years is the GUI default, not an API maximum. `all` and `max` are not accepted.

The Assets UI sends explicit dates. Its initial window is five calendar years through the user's local today, with leap-day clamping. Loading an archive restores its saved requested dates unless the download draft has been edited. Navigation and date edits do not collect data; downloading remains explicit. Requested dates and actual per-asset coverage are distinct.

RPC `market.fetch` accepts `{symbols, store, start?, end?}`; authenticated HTTP `/api` accepts `{method:"market.fetch", params:{symbols, start?, end?}}`. The HTTP server injects the storage path and rejects client-supplied paths. Without dates, the legacy `range=1y` URL and schema 0.1 remain unchanged. Explicit requests send Unix seconds for UTC midnight on the start date as `period1`, and UTC midnight after the end date as exclusive `period2`. Normalization then bounds bars by their exchange-local observation date, or the explicitly labeled UTC fallback if timezone data is unavailable. Out-of-range bars are excluded before indicator calculation; raw response bytes and events are preserved. Events are provenance records, not fills or dividend cash flows for the selected period.

Schema 0.2 records `manifest.requested_bounds` as `{start,end,inclusive:true,interval:"1d"}`. Loading reconstructs and strictly compares the bounds and request URLs, and verifies all raw hashes. Actual coverage comes from the first and last dates and count in each `symbols[].bars` array, plus each summary row's `first_date` and `last_date`. `summary.pricechange_pct` is the first-to-last saved close change shown as **Archive Δ**. It is not guaranteed full-request coverage, an annualized return or necessarily a one-year result.

A new latest pointer is published only after every requested symbol has valid bars and all archive files are written. Any symbol failure preserves the previous pointer and older archives. A failed write may leave unpublished files; it does not replace the last good pointer. Longer or future-dated requests do not create provider coverage. Positive Unix timestamps, USD-only normalization, potentially incomplete latest bars, labeled timezone fallback, non-PIT data and unverified survivorship bias remain limitations. Backtest, portfolio and analytics still require exact observed-session alignment: no interpolation or automatic intersection.

Offline date-path checks are in [test_market.py](../tests/test_market.py), [assets-events.test.js](../tests/ui/assets-events.test.js), [gui-server.test.js](../tests/ui/gui-server.test.js) and [asset-dates-e2e.test.js](../tests/ui/asset-dates-e2e.test.js). The last connects the production DOM → HTTP → Node → Python RPC → temporary archive → public CLI, replacing only Yahoo I/O with test responses. These tests do not establish live coverage or native user acceptance. A running web server caches Python modules and server code: stop the owned server in its terminal, restart with `pnpm start:web` from the root, and open the newly printed URL. Browser refresh alone does not restart the backend.

### Run research with test data

These commands use synthetic inputs designed for accounting verification, not as substitutes for actual market analysis. Fixtures now live under [tests/fixtures](../tests/fixtures). A runnable accounting example uses [normal.json](../tests/fixtures/p2/normal.json) with [spec.json](../tests/fixtures/p2/spec.json). Input validation and execution readiness remain separate.

| Command | Purpose |
|---|---|
| `data validate DATA` | Validate a synthetic dataset. |
| `data at DATA --at AWARE_ISO_TIMESTAMP` | Inspect input observations and membership available at a timezone-aware ISO timestamp. |
| `spec validate SPEC --data DATA` | Validate a research specification. Execution may still fail if required prices are unavailable. |
| `research run --data DATA --spec SPEC [--store PATH] [--no-save]` | Run and save synthetic research. With `--no-save`, nothing is saved and `run_id` is `null`. |

### Saved results and notes

| Command | Purpose |
|---|---|
| `runs list` | List saved synthetic runs and their IDs. |
| `runs show ID` | Read a saved result bundle. |
| `runs replay ID` | Recalculate saved inputs with the same engine version and verify exact result equality. |
| `runs compare ID1 ID2 [ID …]` | Compare runs whose comparison contracts match. |
| `decisions list ID` | Read notes for a run. |
| `decisions add ID --text "NOTE"` | Save the requested text unchanged. This is not order approval. |

`runs` and `decisions` also accept `--store PATH`, defaulting to `.itt/runs`. Keep the same store throughout a task. Do not bypass rejected comparisons or replay-version mismatches with separate calculations. Preserve existing bundles.

[store.py](../src/itt/store.py) publishes canonical JSON input, specification and result snapshots with a manifest and SHA-256 hashes in a new UUID directory. Notes are separate append-only records. Readers validate inventory, schemas, hashes, engine version and comparison metadata, and reject linked paths and Windows reparse points. Bundles are immutable through this API, not OS write-protected or signed; path checks are not a sandbox against concurrent hostile replacement.

The comparison contract fixes the dataset hash, engine version, dates, initial cash, fee and slippage rates, quantity step, benchmark, execution, valuation and lookback. Comparison requires at least two distinct compatible runs; compatibility does not mean replay verification. Replay requires exact canonical equality of the complete recalculated result. Hashes detect integrity problems, not source authenticity or independent accounting correctness.

### Responses and errors

The CLI writes one `{ok:true,result:…}` or `{ok:false,error:…}` envelope to stdout. Streaming support does not insert progress lines into existing CLI output. Only `--help` is plain text. In PowerShell, capture `$LASTEXITCODE` immediately and collect stderr separately.

- Success requires both exit code 0 and `ok:true`.
- Exit code 2 means rejected input; exit code 1 means I/O failure.
- Empty output, malformed JSON or a missing result is not success.

## Criteria and calculation contracts

### Technical signal display versus backend values

Python's `technical-vote-v1` retains `Buy`, `Sell`, `Neutral` and `Unavailable`, including the `Neutral` count key. In [app.js](../ui/gui/app.js), `signalText()` maps Neutral to visible **Hold** only in signal presentation: labels, vote counts, rule text and the three existing per-indicator colored vote markers. Preserve backend values and calculations. Green Buy and red Sell are directional votes; yellow Hold means no directional vote for an individual indicator, or no two-vote Buy/Sell majority for the aggregate. Hold is not an executed hold, position instruction or order. Missing inputs remain Unavailable.

Only SMA20/SMA50, MACD/signal and RSI contribute to this vote. The 13 technical **Reading** rows are categorical interpretations, not 13 votes or a new voting policy. These default signals remain separate from user-defined Backtest criteria; the [architecture](03-architecture.md) retains the backend threshold table.

### One Backtest workspace and one rules source

The `backtest-workspace` in [index.html](../ui/gui/index.html) is a standalone top-level view outside Markets. Single asset, Static allocation and Dynamic allocation share the same form and results. The primary flow is description → **Generate rules** → readable **Buy / Sell / Hold** summary → **Review rules & settings** → **Run backtest**. Backtest has no visible chat. `copilot.analyze` explains selected Markets data; it does not generate or execute active rules.

In natural-language mode, `activeRules()` in [app.js](../ui/gui/app.js) returns only a proposal matching the current description and source identity. Description or source changes invalidate earlier proposals and reviews; revision checks reject late responses. `runBacktest()` runs only when the current specification matches the reviewed serialized specification. Date, weight and cost changes require another review. **Build rules manually** is an explicitly selected secondary path. Active advanced JSON disables simple inputs; never silently flatten generated compound rules.

### Declarative compound criteria

[criteria.py](../src/itt/criteria.py) and the [shared JavaScript validator](../ui/criteria-schema.js) define the accepted format. An abstract syntax tree (AST) represents rules and operands as data; it is not a mechanism for running generated Python.

| Element | Accepted values and limits |
|---|---|
| Comparison | `{left,op,right}` with `gt`, `lt`, `gte`, `lte`, `eq`, `crosses_above` or `crosses_below`. |
| Compound rule | Nested `{all:[…]}`, `{any:[…]}` and `{not:…}`. Each `all` or `any` has 1–32 children. |
| Named operand | Allowlisted existing OHLC and technical-indicator names, not arbitrary properties. |
| Custom indicator | `{indicator,period,lag?}`: `sma`, `ema`, `rsi`, `roc`, `return`, `volatility`; period 1–252 and backward lag 0–252 observed sessions. |
| Price or volume | `{field,lag?}`: `open`, `high`, `low`, `close`, `volume`, with the same lag range. |
| Arithmetic | `{operation,left,right}`: only `add`, `subtract`, `multiply`, `divide`. |
| Numeric input | Finite JSON numbers or decimal strings on comparison right sides and in arithmetic. Prefer strings to preserve precision. Cash, costs and weights are decimal strings. |
| Complexity | Each entry/exit rule has depth ≤12, nodes ≤128 and cost ≤4096. Depth counts rules and operands from root 1, excluding list containers. Cost counts nodes, weights indicators by period and doubles crossing-operand subtree costs. |

Decimal strings are limited to 64 characters and exponents from -100 to 100. A comparison's left side must be a supported series name or structured operand, not a bare numeric literal. Extra keys, unknown structures, function calls, file access, network access and arbitrary code execution are rejected.

Custom indicators use closes. SMA averages the latest $p$ closes. EMA starts with an SMA seed and then smooths with `2/(p+1)`. RSI uses Wilder smoothing seeded by the averages of $p$ close changes; unchanged prices produce 50. SMA/EMA first exist at index $p-1$; RSI, return, ROC and volatility at index $p$. `return` is the fraction `close[t]/close[t-p]-1`; `roc` is that value multiplied by 100. `volatility` is the population standard deviation of $p$ simple one-session returns, without annualization. Arithmetic uses Decimal precision 28 with half-even rounding; division by zero and nonfinite results become `null`.

Crossings require both previous and current observations. An upward crossing means previous `left <= right` and current `left > right`; a downward crossing means previous `left >= right` and current `left < right`. Any unavailable child makes the entire compound rule `null`, including `any(true,null)`. If either entry or exit is unavailable, the signal is `unavailable`; if both are true, exit wins. Warmup uses the full archive causally, never future values to construct past signals.

### Single-asset and allocation backtests

`CriteriaSpec` takes `archive_id`, `symbol`, `start`, `end`, `initial_cash`, `fee_bps`, `slippage_bps`, `entry` and `exit`. The archive ID must match, and both endpoints must be exact saved observation dates. The inclusive window must contain at least two observations, with start before end. Initial cash is positive; each cost satisfies `0 <= bps < 10000`.

`PortfolioSpec` replaces `symbol` with 1–10 `weights` and `rebalance_every`, with optional `allocation` and `rebalance_calendar`. Each weight is 0–1 and their sum is in `(0,1]`. Every asset must have matching dates, timestamps, timezone and date basis throughout the selected window, all in USD. There is no intersection, forward fill or date shifting.

- Fixed allocation evaluates the shared criteria separately for each asset every day. Exit removes eligibility, entry enables it and hold preserves it. Ineligible weight stays in cash rather than being redistributed; unavailable assets keep their quantities fixed during rebalancing.
- `allocation.mode="momentum"` ranks eligible assets by trailing close returns calculated from the full archive. `lookback` is 1–252 (default 20), `top_n` is 1–10 (default 1), and `minimum_return` is a decimal string (default `"0"`). Only returns strictly above `max(0,minimum_return)` qualify. Sort by descending return, then symbol for ties, and split the original total weight equally among selected assets. Unselected or unavailable assets target zero; no candidates means cash. Zero-weight assets still present in an API specification remain momentum candidates; remove them from the specification's asset list to exclude them.
- `rebalance_calendar` defaults to `sessions`, deciding at window indices 0, N, 2N. `monthly` and `quarterly` treat the window start as period 0, then decide on the first observed session of every Nth observed month or quarter. N is the positive integer `rebalance_every`. Monthly N=1 means a close-time decision at the start and each month's first observed session, followed by next-open execution—not month-end execution. Missing calendar periods are not synthesized, and the final observation creates no order.
- The GUI disables the interval input for monthly/quarterly schedules and sends `rebalance_every=1`. CLI/API callers can still specify N for calendar schedules. UI and Python lookback defaults may differ, so compare returned `spec` and `contract`, not assumed defaults.

Integer target quantities are fixed using decision-day closing NAV and prices. At the next observed open, sells execute first, followed by alphabetical, cash-limited buys. Unfilled remainders expire. A single-asset strategy buys with available cash when flat and sells the entire position on exit. There is no shorting, borrowing or forced final liquidation. The allocation benchmark sets targets from the original weights at the first close and buys once at the next open.

### Costs and interim/final performance

Slippage rate $s$ and fee rate $f$ are each `bps/10000`. Buy price is `open*(1+s)`, sell price is `open*(1-s)`, and fees are `quantity*fill_price*f`. Affordable buy quantities include fees. Strategy and benchmark share the same dates and cost rules; each simulator keeps cash and positions in an exact-rational ledger. Progress reads that ledger instead of maintaining separate accounting.

`metrics_snapshot()` in [progress.py](../src/itt/progress.py) computes interim and final metrics from the same ledger. Net asset value (NAV) is cash plus close-valued positions. Maximum drawdown (MDD) is the positive running maximum decline from a peak that includes initial cash. Compound annual growth rate (CAGR) is:

$$\mathrm{CAGR}_t=\left(\frac{\mathrm{NAV}_t}{\mathrm{initial\_cash}}\right)^{365.25/d_t}-1$$

$d_t$ is elapsed calendar days from the start. Zero elapsed days or numeric overflow produces `null`, not 0%. NAV is an exact finite decimal string; ratios use Decimal precision 28 with half-even rounding. CAGR, MDD and total return are fractions, multiplied by 100 only for display. Market `pricechange_pct` is already a percentage. Do not confuse a point-in-time drawdown curve with running maximum drawdown.

Dividends and splits are not reapplied, and dividend total return is not calculated. Integer units at current Yahoo adjusted prices do not reconstruct actual historical share counts. Point-in-time (PIT) research uses only information available at the time; archive hashes and collection timestamps cannot prove historical publication times or freedom from survivorship bias.

### Correlation and retrospective event studies

`CorrelationSpec` in [analytics.py](../src/itt/analytics.py) takes `archive_id`, `start`, `end`, 2–10 unique `symbols`, and `frequency` (`daily` by default, `weekly` or `monthly`). Alignment checks cover dates, timestamps, timezone, date basis, currency and exact endpoints.

Daily sampling uses every observed close; weekly sampling uses each ISO week's last observed close; monthly sampling uses each calendar month's last observed close. Pearson coefficients use simple returns **between sampled closes inside the requested window**. No pre-window base price or out-of-window period-end price is imported; partial boundary weeks and months are included. Results contain `sample_dates`, `returns` and a common `observations` count. Fewer than two returns gives `insufficient_returns`; zero variance gives `zero_variance`. Both produce `null` coefficients, not zero. Valid coefficients are JSON numbers.

`TriggerSpec` takes the same archive/window identity plus `symbol`, `target_symbol`, `condition` and `horizons`. Horizons are unique integers from 1–60, defaulting to `[1,5,20]`. Every observation where the condition is true is an event, not just false-to-true transitions. Historical warmup is allowed, but outcomes are `target_close[t+h]/target_open[t+1]-1` and must finish within the requested end date. At h=1 this is the next observed session's open-to-close return.

Incomplete outcomes are `null`. Mean, median and win rate use complete samples only; win rate is the fraction with return `>0`. Overlapping sample windows are flagged, with no significance tests or multiple-testing correction. Future prices are used only for retrospective outcomes, never event selection. This is **retrospective analysis without fees, slippage or an execution model**, not the cost-aware backtest above or proof of causation.

**Research / Event studies defaults to Independent condition**, as implemented in [research.js](../ui/gui/research.js) and [index.html](../ui/gui/index.html). It needs no Backtest review. Users choose a saved condition asset, a supported left operand/comparison/right operand or decimal number, exact saved start/end sessions, a target asset and horizons. The initial condition is RSI14 below 30. Changing the condition asset initializes its saved-session window; changing the target does not shift dates. Both assets must contain the chosen endpoints; there is no automatic adjustment.

The optional **Reviewed Backtest entry and dates** source requires `rulesReviewed()`. Only this mode reuses the current selected symbol, reviewed `entry` and Backtest dates, disabling the independent controls. Target and horizons remain explicit inputs in both modes, and both call `market.trigger` with a validated specification. Neither uses exit rules or Backtest costs. Input/source changes invalidate results and stale responses are discarded; independent studies do not depend on unrelated Backtest edits. Independent manual analysis is implemented, but generating the entire event specification from a natural-language question alone remains a separate feature.

### Automatic Guru reference API

[guru-service.js](../ui/guru-service.js) is a Node adapter issuing unauthenticated GETs only to the fixed `https://easyinvesting.app/api/guru/*` origin. Authenticated `/api` routes in [gui-server.js](../ui/gui-server.js) handle local requests without Python price calculations or Yahoo archives. [guru.js](../ui/gui/guru.js) loads funds and quarters when Guru opens, then fetches details as selected. App startup or Markets lookup alone does not call the feed. There is no frontend upload, cache or performance calculation.

| Local method | Fixed remote path and inputs |
|---|---|
| `guru.funds` / `guru.quarters` | Read `funds` / `quarters`. |
| `guru.fund` | `fund/{id}/holdings`; a listed 10-digit CIK and optional quarter. |
| `guru.popular` | `popular` / `buys` / `sells`; quarter, index inclusion and limit up to 30. |
| `guru.changes` | `recent-changes`; quarter, index inclusion, limit up to 200, and optional CIK and NEW/INC/DEC/SOLD filters. |

Each method accepts optional `refresh`. The server allowlists paths and parameters and rejects redirects and cookie forwarding. Defaults are a 15-second timeout, 8 MiB response limit, eight concurrent requests, and a five-minute memory cache bounded to 64 entries and 32 MiB. In-flight requests for the same URL are shared. Checks cover status, JSON MIME, UTF-8, structure, nonfinite values and response ID/quarter, but are not a comprehensive security audit or source-authenticity check. HTTP 429 records a wait state without automatic retry. Expired cache entries and failed explicit refreshes never return old cached data as substitute results.

Responses contain `{data,source,limitations}`. Preserve provider fields, missing values and notes in `data`; `source` records URL, fetch time, cache status/age, upstream cache age and units. Overview defaults to rows where both `active` and `show_in_default` are true. Separate historical public-GET checks observed 79 such funds out of 87, not a permanently fixed list or availability guarantee. Views include details, popular holdings/buys/sells, changes and filing status, with search, quarter, fund and style filters.

Keep titles, tabs, filters and Overview summaries/counts compact. A short estimate/delayed-13F warning remains visible; full provider notes and limitations expand under **Provider notes and data limitations**. Detail order is holdings table → filing summary → secondary performance and portfolio weights. Compact layout must not remove warnings or original notes.

Returns, `pct_portfolio` and `pct_change` are already percentage-point values: never multiply by 100. YTD is the `returns.yearly` value for the year of `return_end_period`. Keep the holdings quarter separate from `return_start_period`/`return_end_period`; historical holdings responses may include later performance. These are provider-calculated **13F-based estimates**, not actual fund returns, SEC certification or ITT's independent financial calculations. The undocumented API's collection schedule, rate limits, SLA and redistribution license are unconfirmed. Successful public GETs do not grant redistribution or commercial-use rights.

### Manual Guru filing input

This is the retained Python `market.guru` RPC/CLI compatibility contract, not the automatic UI. Manual frontend upload has been removed; automatic reference responses are not converted into this specification for calculation.

`GuruSpec` in [guru.py](../src/itt/guru.py) is `{filings,as_of}`. Each filing requires `manager`, `period`, `filed_at`, `source_url` and `holdings`; each holding requires `cusip`, `name`, `value_usd` and `shares`. Dates use `YYYY-MM-DD`; amounts and quantities are decimal strings. `value_usd` is actual USD, not thousands of dollars. Users normalize actual filings before input. There is no network collection, file writing or price-history linkage.

Validation checks `period <= filed_at`, HTTPS URL syntax with the exact `www.sec.gov` host, and input bounds. Limits are 1,000 filings, 10,000 holdings per filing and 100,000 holdings overall. Amounts have at most 64 characters, range 0–`1e18`, and Decimal exponents -18–18. Duplicate manager/period pairs and duplicate CUSIPs within a filing are rejected. Resolve amendments, aggregate comparable rows and normalize identifiers before input. Python accepts empty lists; transport limits must be checked separately.

Only filings with `filed_at <= as_of` are visible, filtered at date precision. Compare each manager's latest and previous supplied available periods, not assumed consecutive quarters. Without prior data, changes are `unknown`; new/exited means supplied row appearance/disappearance, not verified buys/sells. Common holdings count distinct exact manager IDs per CUSIP in their latest visible filings. Weights use the sum of imported holding values; a zero total gives zero weights.

13F filings generally arrive up to 45 days after quarter-end and may be late or amended. SEC URL checks do not retrieve or authenticate filings or establish their actual historical publication time. This path covers normalized long US-equity holdings, not full fund assets. Actual 13F coverage includes some options and ADRs; do not combine incompatible instruments arbitrarily. Without trade dates, prices, cash flows, dividends or costs, this manual Python path does not calculate fund performance, CAGR or MDD. Keep it separate from provider-estimated performance in automatic Guru.

### Full-viewport Quant Swarm demo

The [Swarm module](../ui/gui/swarm.js) replays the authored 60-second scenario with eight agents, six chapters, four message-driven pivots and 12 candidates. One screen contains controls, phases and activity, an auto-follow inspector, the latest three messages, a top-four candidate table, all 12 lineage nodes and the current cause. It uses a purple Beta background and [eight Koboyo people SVGs](../ui/gui/avatars/README.md). The icon guide preserves provenance, original URLs and licenses. These are fixed decorative identities, not an icon library or picker, and require no external icon requests at runtime.

The [workspace controller](../ui/gui/research.js) shows `copilot-panel` only in Markets. All other workspaces hide the same node and use `.chat-hidden` to reclaim the desktop sidebar and narrow-screen bottom dock. DOM, history and drafts persist and reappear on return to Markets. Leaving Swarm pauses playback. The demo targets no-scroll layouts at 1366×768, 1440×900, 1920×1080 and 800×1000; widths ≤600px use a scrollable fallback. The Swarm-only chat-hiding policy in the [earlier report](change-history/2026-09-11-future-scope.md) is historical, not current policy. All performance is fictional; playback calls no API, model or backtest.

## RPC and HTTP progress streams

NDJSON carries one JSON object per line. Historical saved-data checks compared progress records and complete final results with the public CLI. Review the contracts together in [rpc.py](../src/itt/rpc.py), [backend.js](../ui/backend.js), [gui-server.js](../ui/gui-server.js) and [app.js](../ui/gui/app.js).

| Layer | Request and response |
|---|---|
| Ordinary RPC | `{id,method,params}` returns one `{id,ok:true,result}` or `{id,ok:false,error}`. |
| Opt-in RPC stream | Only `market.backtest.stream` and `market.portfolio.stream` emit interim `{id,event:'progress',data}`, ending with one ordinary final response for the same ID. Both take `store_path` and `spec` in `params`. |
| Progress data | `data` contains `phase` (`strategy` or `benchmark`), `completed`, `total`, `date`, `nav`, `cagr`, `max_drawdown`. Counts are actually processed observations per phase, not elapsed-time estimates. |
| HTTP stream | `POST /api/stream` takes `{method:'market.backtest',params:{spec}}` or the ordinary method name `market.portfolio`. The server selects the RPC `.stream` method. Host, Origin, `X-ITT-Token` and JSON checks match ordinary `/api`. |
| Browser records | HTTP sends `{event:'progress',data}`, then `{event:'result',result}` or `{event:'error',error}` as NDJSON. Node correlates RPC progress IDs with requests and routes them to the corresponding HTTP stream. |
| Other RPC methods | `market.correlation` and `market.trigger` take `{store_path,spec}`; `market.guru` takes only `{spec}`. Ordinary HTTP analysis requests accept only `{spec}` and the server supplies any required store path. |

Never treat progress as a final response or route it to another request. Ordinary RPC and CLI remain single-result interfaces. Disconnection before the final result, malformed records and errors are failures; partial performance cannot stand in for success. The browser creates no automatic retries, timer-based progress or fictional prices. **Hide progress charts** and **Show progress charts** only change visibility, not cancellation or parallel execution. Synthetic `research.start` job polling and saved-market streams are separate paths.

### Desktop JSON export

[desktop-policy.js](../ui/desktop-policy.js) permits only same-origin blobs initiated by an Electron-confirmed user gesture from the app-owned current page. It requires one unchanged URL with no redirect, JSON MIME (`application/json` or `text/json`), and a known positive integer size up to 8 MiB. Allowed download names are `itt-correlation.json`, `itt-trigger.json`, `itt-backtest.json` and `itt-portfolio.json`. Filename, MIME and blob-URL checks validate metadata, not JSON contents or source authenticity. The size cap is a desktop restriction, not a guarantee about maximum backend result size.

The product retains Electron's native save dialog. The pre-redesign [native verification report](../output/future-desktop-verification/runs/2026-09-11T01-53-49-497Z-y5HrBq/report.json) checked export completion/cancellation, automatic-download blocking and dialog configuration in actual Electron. A later launch was blocked by an existing user-owned ITT process, which was not terminated. Browser success does not replace native revalidation. The test listener supplied the save path, so this is not evidence of direct OS-dialog interaction. External navigation, popups and permission requests remain blocked.

## External agents reading the same data as the UI

Agents should read the [project skill](../.github/skills/itt-research/SKILL.md) first and use the public CLI. Do not substitute private functions, screen scraping, generated strategy code or independent financial calculations. Skill autodiscovery and use in other hosts require separate verification; MCP is not implemented.

1. Read the latest archive with `market show`. This makes no network request.
2. Compare `result.manifest.id` with the UI handoff ID on every read. On mismatch, stop: do not fetch, scan older folders or substitute another archive.
3. Find exactly one bar matching the symbol and integer Unix timestamp in seconds. Also verify its date and `date_basis`.
4. Read OHLCV, indicators and signal reasons at the same array index. Preserve `null`; never fill from `summary.last_price`.
5. Include archive ID, symbol, observation time, provider, collection UTC, price/date basis and data limitations in the handoff.

No matching row, multiple matches or an incomplete response is failure. Before comparing backtests, fix the archive, dates, costs, benchmark and metric definitions, and check start-date sensitivity. Do not add calculation-code rules absent from the deployed criteria specification.

## Request scope and Copilot

A lookup does not authorize unrelated installation, collection, saving, model calls or deployment. Conversely, do not add arbitrary repeated approvals to work the user has requested. Follow model-service and organizational policies when sharing data with external agents. Never put tokens or passwords in arguments, chat or notes. Do not use Orca.

GitHub Copilot is the only current LLM scope. Topbar **Settings** is the sole setup entry, accessible in every workspace, and contains connection checks and model selection. Opening it makes no request; Escape returns focus to the topbar button. **Check connection** and `node ui/copilot-cli.js status` read authentication metadata and, when authenticated, available models—not inference or market data transmission. Do not add separate connection buttons to chat or Backtest. The account toggle only expands already loaded information; it does not switch accounts. The default is `authOnly=false`; Enterprise entitlement is not a required gate.

For public Node commands, append `analyze` or `criteria` and `--symbol SYMBOL --timestamp SECONDS --archive-id UUID --model MODEL-ID --question "QUESTION"` to `node ui/copilot-cli.js`. Use a model ID returned by readiness checks, a positive safe-integer timestamp, and a trimmed question of 1–4000 characters. Unknown, duplicate or missing arguments are rejected; there is no Node `--store`. Python collection and Copilot symbol validation are separate. If the remaining Copilot allowlist rejects a symbol, do not replace it with another symbol or bypass validation.

An explicit public-data analysis or criteria-generation request authorizes transmission of the selected data; there is no separate mandatory consent checkbox. Legacy `--consent` is optional, while explicit API `consent:false` is rejected. Before inference, the service rereads the default archive and checks its ID. It sends only the selected symbol's bars from archive start through the selected timestamp, aligned indicators, definitions, restricted metadata and the question. Future bars, other symbols, local paths and notes are excluded. SDK file, shell, MCP, search, research-execution and order tools are disabled. There is no automatic retry or provider fallback.

This context excludes Backtest results, correlation, event studies, Guru and Swarm. Chat therefore belongs only in Markets and must not imply it can explain other workspaces. Preserved chat history is not included in request context either.

Review nested criteria JSON without flattening it, then execute explicitly. Do not approximate ambiguous or unsupported intent with keyword rules or generated-code execution. Before the redesign, two real `gpt-5.4-mini` calls on the same Korean case preserved SMA17, RSI9, AND entry and OR exit semantics. The second call's complete backtest result matched the public CLI. This is one case repeated twice, not two distinct cases or general multilingual/analysis-quality validation.

The original verifier incorrectly required undocumented `supported:true` and marked the response as failed. [Offline revalidation](../output/live-criteria-verification/revalidations/2026-09-11T01-48-12-158Z-10YqG3/report.json) passed by comparing existing responses, streams and downloads with the read-only public CLI. It made no new inference, status or GUI calls and added no production field. Require `ok:true` and valid `criteria`; accept omitted `supported` but reject explicit `false`. Preserve the original proposal in the editor; preview normalizes only omitted `lag:0`. Do not report the first run's unfinished GUI checks as newly completed.

`contextIdentity` and hashes identify inputs, not factual accuracy. Missing token counts or USD costs mean unknown, not zero. Usage is aggregated per answer in memory, not account billing. Node success also requires exit code 0, `ok:true` and readiness appropriate to the operation.

## How to verify changes

End-to-end (E2E) verification follows the actual UI/public CLI path through Python services. Unit tests, mocked SDKs and screenshots alone do not prove real-model behavior or a complete user workflow. The following is a checklist for future changes, not a claim that those checks ran during this documentation update.

### Fix the evaluation contract first

Read the confirmed requirements and task scope without inventing assumptions or approval gates. Fix the archive, exact dates, criteria, costs, benchmark and expected results before evaluation.

### Check the actual application

- Compare symbols, dates, indicators and signal reasons with public CLI results from the same archive. Verify value invariance after changing the display range and preserve `null` displays. Check the three existing colored vote markers and visible Hold labels/counts/rule text against unchanged backend Neutral values; do not reinterpret the 13 Reading rows as votes.
- Confirm that advanced proposals survive review → execution without simplification. Date or asset changes require review; old responses must not appear as results for new inputs.
- Check progress-ID correlation, strategy/benchmark phases, final interim-versus-final metric equality, the progress bar after hiding charts, malformed records, errors and EOF before a final result. Ordinary RPC/CLI must still return one result.
- Check correlation's partial weeks/months. For events, verify independent mode without Backtest review, the review gate only for optional Backtest reuse, exact endpoints, input invalidation and overlapping outcomes. Check momentum's first-session decisions, next-open fills and cash positions. Separately test automatic Guru's stale-response rejection, filters, missing values, percentage units, holdings/performance dates and cache/failure boundaries, and manual Python Guru's as-of dates, duplicates and missing prior filings.
- Check explicit download dates through UI, HTTP, RPC and CLI, including saved-request restoration, requested-versus-actual coverage and preservation of the previous archive on failure.
- Match English app titles, buttons and status text to the English guides; check keyboard and narrow-window operation. Arbitrary provider/user text is not forcibly translated. Confirm that Swarm is labeled simulated and makes no model calls.
- Verify Markets-only chat, reclaimed space in Backtest, every Research tab and Swarm, and the same DOM/history/draft after returning. Settings must remain globally accessible. For Guru, inspect the short warning, first row below filters, holdings-first detail and expandable full notes.
- Ensure status checks do not infer, and only requested analysis/criteria generation transmits scoped data. Explicit transmission refusal, invalid tokens and invalid Origins must be rejected.
- Confirm that lookups do not collect, write or substitute archives, and shutdown cleans up only app-owned server/Python processes.

### Check code and tests

Trace authorization and input validation at each request boundary; preserve existing data on save failure. Compare accounting with an independent oracle and verify that future-data mutations cannot change past signals or targets. Test AST depth, node, cost, period and lag limits, and `null` propagation.

Relevant tests cover [criteria](../tests/test_criteria.py), [allocation](../tests/test_portfolio.py), [progress](../tests/test_progress.py), [analytics](../tests/test_analytics.py), [Guru](../tests/test_guru.py), [RPC](../tests/test_rpc.py), [CLI](../tests/test_cli.py), [server](../tests/ui/gui-server.test.js) and [Copilot](../tests/ui/copilot.test.js). An old test or report is not evidence that the current change passed.

Run `pnpm test` from the repository root to execute `node --test tests/ui/*.test.js`. For sequential browser/resource verification, run `node --test --test-concurrency=1 tests/ui/*.test.js`. The [dependency helper](../tests/ui/helpers/dependencies.js) resolves Playwright from the locked UI installation through `createRequire`; no second installation or symlink is needed. Set `ITT_TEST_OUTPUT_DIR` to an external directory to keep new layout screenshots and reports outside existing repository artifacts. Start/check commands and the product [probe](../ui/probe.js) remain unchanged.

Optional standalone capture and verification entry points are local-only under tools/local, excluded from Git and not required to start the app or run tests. On a workstation that retains them, run them from the repository root, for example `node tools/local/verify-gui.js` or `node tools/local/verify-desktop.js`. Check their assumptions against the current UI and authentication policy before execution; some explicitly contact live services or create artifacts. Production imports resolve through `../../ui`, and local package resolution is anchored to the UI package. Shared fixtures and reusable offline browser checks remain in [tests/ui/helpers](../tests/ui/helpers), so a checkout without local tools retains the default test coverage.

### Record results honestly

Record the environment, command or interaction, expected and actual results, and evidence location. Leave untested items untested and distinguish developer checks from user acceptance. The [change history](change-history/2026-09-11-future-scope.md) separates historical Guru/chat layouts and Node/UI runs, earlier Swarm/Node results, and browser integration, live Guru and layout corrections. Do not present historical full-suite counts or sums of focused checks as a current full-suite result. Guru layout and saved-market integration fixtures are not real reference-API evidence. Browser success is not full product acceptance, SEC source authentication or independent performance verification.

Preserve the initial failure status in the [real-model session summary](../output/live-criteria-verification/session-summary.json); read its `corrections` together with the offline revalidation above. Its Python regression and real-model results remain historical and are not refreshed by later Node/UI tests. Video production remains deferred with existing media preserved; English sources have not been newly rendered.

## Open work and verification gaps

| Area | Remaining work |
|---|---|
| Reference-feature differences | Automatic Guru retrieval and independent manual event studies are implemented; prior browser integration evidence is recorded. Explicit date-range downloads also exist, but provider coverage and long-history parity are not guaranteed. Multi-currency support, 30 assets, the full named-strategy catalog, independent fund-performance calculations, data-use rights and complete natural-language event-spec generation remain separate work. |
| Research persistence failures | Intermittent `unable to save run` failures recurred in the unchanged Windows [store.py](../src/itt/store.py) path. A rename-time `PermissionError` was also observed; cause and resolution remain unconfirmed. A later green suite is not evidence of a fix. |
| Installation and user operation | Current native Electron revalidation, fresh installation, double-click launch, shutdown and user acceptance remain separate checks. Do not forcibly terminate existing user processes for verification. |
| Real AI quality | Evaluate Copilot's multilingual semantics, criteria preservation, provenance and usage beyond the one observed Korean case. Azure OpenAI/OpenAI expansion is not a current obligation. |
| Data limitations | Saved-price backtests do not establish PIT availability, survivorship-bias removal, dividend total return or data-use rights. Synthetic engine tests cannot establish those properties. |