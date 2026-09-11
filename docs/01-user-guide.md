# User guide

ITT is a research tool for defining conditions and comparing results using saved market data. Select an asset and date to inspect prices, volume, indicators and their sources. SPY, QQQ, IWM and MSFT are default examples; downloads support 1–10 unique Yahoo symbols with explicit start and end dates, daily bars (`1d`) and USD prices only. There are no live quotes or order execution.

The main workflow is **Describe a strategy → Generate rules → Review rules & settings → Run backtest**. Earlier records document successful offline Guru layout and Markets-only chat checks, plus a full Node/UI regression run that included integrated Swarm checks. Saved-price/public-CLI parity and live Guru response checks are separate historical evidence. These records do not establish new native Electron, model, live-feed, financial-calculation or full Python regression verification, or user acceptance. See [docs/change-history/2026-09-11-future-scope.md](change-history/2026-09-11-future-scope.md) for the recorded scope.

Control names below match the English interface. User questions and provider responses may remain in their original language.

## Start the app and load market data

After installation, run `pnpm start` from the repository folder. Setup instructions are in [docs/02-developer-guide.md](02-developer-guide.md).

The app opens previously saved market data on startup. To request new data, open **Assets** from the left rail or **Data** in Markets. Opening this screen does not download anything. Assets manages the saved universe shared by Markets, Backtest, Correlation and Event studies; Guru has a separate reference feed, and Swarm is a concept demo.

In **Assets**, enter comma-separated symbols, set **Start date / End date**, then select **Download market data**. Both dates are inclusive. A fresh form defaults to five calendar years before today through today, using the computer's local calendar; a February 29 start is clamped to February 28 when needed. Loading an archive with recorded request dates restores those dates unless the download draft has been edited. Legacy one-year archives have no explicit request dates, so a fresh form keeps the five-year default without downloading. There is no all-history or maximum-history option.

**Saved requested window** shows the requested download range. **First session / Last session / Sessions** show each asset's actual first and last saved observation and observation count. Listing dates, holidays, missing data and provider limits may shorten coverage or make it differ across assets. The latest bar may be incomplete. A same-day request is allowed but fails if it yields no valid observations; a failed download preserves the previous active archive.

A download creates a new active archive containing only the entered symbols; it does not merge with previous data or delete older archives. When loading the former default universe containing exactly SPY, QQQ and IWM, an unedited download draft adds MSFT. This changes only the proposed download selection, not the saved data; custom universes remain unchanged. MSFT is collected only after **Download market data** is selected.

Edited dates and symbols survive navigation and verification. Reloading the page restores the saved request dates, or fresh defaults for a legacy archive, and rebuilds the symbol draft as described above. Switching tabs or applying an allocation example never downloads data or adds substitute assets.

**Verify saved data** rereads the saved manifest and raw files to check integrity. It does not download newer prices, authenticate the provider or prove historical availability. A failed read never triggers an automatic download.

## Select an asset and date to inspect the chart

Choose an asset from the left list, then select a date on the chart or in the observation list. Expand **Evidence** to inspect that date's open, high, low, close and volume.

A **daily bar** is one observed trading session's price record. **Candles** shows its price movement as a candlestick; **Line** shows the price path as a line. Controls above the chart change the display:

| Control | Purpose |
|---|---|
| 1M / 3M / 6M / 1Y | Show the latest 21, 63, 126 or 252 daily bars, not exact calendar months or years. |
| Archive | Show all saved bars for that asset. This is not a full-history download option. |
| Volume | Show or hide trading volume. |
| SMA20 / SMA50 | Show the mean of the latest 20 or 50 closes, smoothing short-term fluctuations to help inspect trends. |
| RSI14 | Show momentum based on gains and losses over 14 periods. |
| Indicator formulas & limits | Explain indicator calculations and their limitations. |

**Changing the visible window does not change an indicator's value for the same date.** Calculations use earlier saved data for warm-up before the display is cropped. Insufficient history remains **Insufficient history** or **Unavailable**, never an invented number.

**Archive Δ** is the percentage change from each asset's first saved close to its last saved close. It is not a one-year return, annualized return or dividend-inclusive total return, and does not change with the chart window. Multi-asset backtests, correlation and event studies require exact date and timestamp alignment. They do not interpolate different coverage or silently trim to a shared intersection. Matching saved sessions alone does not validate the exchange calendar or reveal dates missing from every asset.

## Understand the technical signal lights

The default signal beside an asset combines three technical indicators using fixed rules. It is neither an AI judgment nor the result of backtesting your strategy.

- **Green Buy:** at least two of the three indicators meet their Buy conditions.
- **Red Sell:** at least two meet their Sell conditions.
- **Yellow Hold:** neither Buy nor Sell receives at least two votes.

The active color has an outline. The three existing per-indicator colored vote markers show the moving-average, MACD and RSI votes: green Buy, red Sell or yellow Hold. An individual **Hold** means **no directional vote**, while the aggregate Hold means no two-vote Buy/Sell majority. It is not an executed hold, an instruction to retain a position or an order. Select the signal button to inspect these votes and their exact inputs. If any required value is missing, the signal is **Unavailable**, not Hold.

Signal labels, vote counts and rule explanations use **Hold** in the interface. The backend still returns `Neutral` under `technical-vote-v1`; this is a display-name distinction only, not a change to calculation rules or Backtest criteria signals.

**Buy and Sell are rule labels, not investment recommendations.** The exact conditions are documented in [docs/03-architecture.md](03-architecture.md). The 13 technical-indicator rows describe values and meanings such as trend, momentum and volatility; they are not 13 additional Buy/Sell votes. Only the three indicators above determine the default signal.

## Build signals and backtests from your criteria

A **backtest** applies entry and exit conditions to historical prices to simulate changes in portfolio value. Top-level **Backtest** is a **standalone workspace, not a panel inside Markets**. **Single asset**, **Static allocation** and **Dynamic allocation** share the rule form, review, execution and results workflow.

1. [Connect Copilot](#connect-copilot-and-ask-questions), choose a mode and saved asset, then write your buy and sell criteria in **Strategy description**. **Generate rules** asks Copilot for bounded declarative rules, not executable code or performance results. Nothing runs automatically.
2. Read the **Buy / Sell / Hold** summary, including exit priority and the rule against trading when inputs are unavailable. Changing the description or source context invalidates the proposal; generate it again.
3. Check the archive, start and end dates, initial cash, fees, slippage, allocation weights and schedule, then select **Review rules & settings**. Dates must be actual saved sessions. Slippage is an unfavorable difference from the reference execution price; 1 bp is 0.01%. Multiple assets must match in dates, timestamps, time zones and date basis, without automatic intersection.
4. Select **Run backtest** to execute the exact reviewed specification. Any settings change requires another review. Compare the daily signals and reasons with the buy-and-hold benchmark using the same dates and costs. These user-criteria signals are separate from the default technical signal lights.

For offline use or direct editing, select **Build rules manually**. Use simple comparisons and crossings, or **Advanced · edit full criteria JSON** for compound conditions, custom periods and references to earlier observations. Selecting JSON as the active source disables the simple inputs so they cannot overwrite compound rules. To edit a generated proposal, explicitly switch to manual mode. Backtest has no chat; use its dedicated generation and execution controls.

Decisions use closing data and fills occur at the next observed session's open, within the selected window. Indicators use the full archive for causal warm-up. Purchases use whole units only, without shorting or borrowing; uninvested funds remain cash. Exit conditions take priority. If either entry or exit is unavailable, no action is taken that day. A missing required value makes an entire compound condition unavailable. End-date signals are not filled outside the window, and positions are not forcibly liquidated on the last day.

### Performance and progress during a run

**NAV** is cash plus holdings valued at the close. **CAGR** annualizes the return using elapsed calendar days and a 365.25-day year. **MDD** is the largest decline from any earlier NAV peak, including initial cash, shown as a positive magnitude. These metrics describe simulated performance and downside risk.

During execution, CAGR and MDD share one chart: blue for CAGR, red for MDD, solid lines for the strategy and dashed lines for the benchmark. All four curves use the same percentage axis without normalization, so very large early CAGR can make MDD changes look small. The completed **Performance · CAGR & MDD** card shows final metrics and daily NAV and drawdown on a shared time axis. Daily drawdown is not the running maximum drawdown (MDD). Axis text keeps its size when the window widens.

**Hide progress charts** hides only the interim charts; the progress bar remains. **Show progress charts** restores them without restarting the calculation. Hiding is not cancellation. Progress reflects strategy and benchmark sessions actually processed, not timer-generated percentages or estimated completion times.

Strategy and Benchmark have separate, fixed labels and completed/total counters, so alternating updates do not replace one label with the other. A dash means that phase has not reported a count yet. Both counters reset for each new run; an error retains the counts actually received. Completion is determined by the final response, not by inventing missing progress counts.

Interim and final metrics use the same calculations and cost ledger. CAGR is unavailable on the start date because no calendar days have elapsed; annualized returns over short periods can fluctuate sharply. Missing values remain gaps. Check the final response rather than treating interim values or a progress bar as proof of success.

## Compare results across research workspaces

**Research** contains **Correlation**, **Event studies** and **Guru**. Static and dynamic allocations belong to top-level **Backtest**; the conceptual simulation is in **Quant Swarm**.

### Correlation

In **Correlation**, choose 2–10 saved assets, exact dates and a daily, weekly or monthly frequency, then select **Calculate correlation**. The **Pearson correlation coefficient** describes how price returns move together on a scale from -1 to 1. Zero suggests little linear relationship, not independence or safety.

Daily returns use consecutive observed closes. Weekly and monthly returns use the last observed close of each ISO week or calendar month. No prices outside the selected window are used, so boundary weeks or months may cover shorter periods. Fewer than two return samples or an asset with no return variation produces an unavailable value, not zero. Inspect sample counts and actual sample dates alongside the matrix.

### Static and dynamic allocation

**Static allocation** sets target weights and rebalances on a schedule. Weights must sum to more than 0 and at most 1. Any unallocated share, or the share assigned to an ineligible asset, remains cash. Helpers offer equal weights across saved assets or SPY 50%, QQQ 30% and IWM 20%. Missing example assets are never downloaded or substituted automatically.

**Dynamic allocation** is a simple momentum approach: rank eligible assets by trailing close-to-close return over a chosen number of observed sessions. Select the top N with returns strictly above the greater of zero and the minimum-return threshold, then split the allocation budget equally among them. If none qualify, remain in cash. This does not reproduce BAA, a reference site's full strategy catalog or optimized weights.

**Rebalancing** resets target quantities. The interface accepts an interval N for saved-session scheduling and uses N=1 for monthly or quarterly scheduling. Monthly decisions occur at the close of the start session and the first observed session of each subsequent observed month, with fills at the next observed open—not at month-end. Static allocation preserves held quantities for assets whose criteria are unavailable; momentum excludes those assets and targets zero holdings. Whole-unit rounding, price changes and costs can make actual weights differ from targets.

### Post-event returns

**Research / Event studies** is a separate retrospective analysis. Its default **Independent condition** mode requires **no Backtest review or run**.

1. Keep **Condition source** set to **Independent condition**. Choose a **Condition asset**, a **Return target · saved asset**, and a comparison or crossing condition. The default example is RSI14 below 30; the right side accepts a decimal number or a listed operand.
2. Choose **Start date · saved session** and **End date · saved session**. Independent studies initially use the condition asset's latest 126 saved bars, or all available bars if fewer. Changing the condition asset reinitializes that window; changing the target does not shift dates. Both endpoints must exist in both assets, the end must follow the start, and the backend requires exact alignment rather than adjusting dates automatically.
3. Enter **Forward sessions** as unique comma-separated integers from 1 to 60, such as `1,5,20`, then select **Analyze post-event returns**. A disabled button has an accompanying reason, such as missing saved data, invalid dates or an invalid condition.

To reuse existing rules instead, choose **Reviewed Backtest entry and dates**. **Optional: review rules in Backtest** opens the review workflow. Only this mode requires reviewed Backtest inputs: it uses the current Backtest asset, active entry criterion (`entry`) and reviewed start/end dates. The condition asset and dates are locked to those inputs; the return target and horizons remain explicit choices. Neither mode uses the exit rule or Backtest costs. Independent studies do not depend on Backtest edits. Changing study inputs or the archive invalidates the result; a stale in-flight response is discarded.

Every session whose close-based condition is true counts as an event, not just the transition into that state. For horizon h, the target's price return runs from the next observed session's open to the h-th forward session's close; h=1 is the next session's open-to-close return. Outcomes requiring prices after the end date remain unavailable, never zero.

This is a **retrospective event study, not a tradable strategy backtest**, dividend total return or evidence of causation. No fees, slippage or execution model apply. Mean, median and win rate use complete outcomes only; a win is a return strictly above zero. Overlapping windows are not independent samples, and no significance tests or multiple-testing corrections are provided. There is no dedicated end-to-end natural-language event-specification generator.

### Review Guru holdings

Opening **Research / Guru** automatically reads easyinvesting's public reference API through the server. No file upload is needed, and app startup alone does not fetch it. The server caches responses for five minutes. **Refresh** rereads the reference API; it does not ask the provider to collect new filings. Failure displays an error and **Retry**, without fabricated data or an expired-cache substitute.

- The compact title, tabs, filters and **Overview** summary leave room for the table. A short estimate/delayed-13F warning remains visible; expand **Provider notes and data limitations** for the full explanation.
- In **Overview**, search managers or funds, use **Fund universe** and **Style** filters, and inspect estimated returns. A historical check observed 79 default funds out of 87 total: those with both `active` and `show_in_default` true. Counts can change with the feed.
- **Fund detail** shows holdings first, then the filing summary and secondary estimated-performance and portfolio-weight charts. Inspect the holdings quarter, values, weights, quantity changes and filing status. The holdings date and **Return coverage** end date are separate; selecting an older holdings quarter does not necessarily truncate performance to that quarter.
- Use **Popular stocks / Holdings / Big buys / Big sells** and the change-type and fund filters in **Recent changes** to inspect provider-reported records. Check the quarter, index-fund inclusion and **Fund filing status**. Search, sorting and pagination operate only on returned data; popular stocks are limited to 30 and changes to 200.

Returns, weights and changes are already percentages: 23.8 means 23.8%, not 2,380%. YTD refers to the year of the provider's performance end date through that date, not the computer's current year. Missing values remain dashes.

Historical browser checks compared real reference responses with displayed rows, percentage units, holdings quarters and return coverage. That does not make **provider estimates actual fund returns or SEC-verified performance**. 13F filings generally arrive up to 45 days after quarter-end and do not show all assets or intra-quarter trading. Quantity changes do not prove trade dates or prices. Public access is not permission to redistribute or use the data commercially. The manual Python filing CLI remains a separate compatibility path, described in [docs/02-developer-guide.md](02-developer-guide.md).

### Quant Swarm Beta

Top-level **Quant Swarm** is a full-screen concept simulation with a purple **Beta** badge. Eight local Koboyo people icons identify scripted agents in a 60-second scenario with six chapters, four message-driven pivots and twelve candidates. All returns, curves and scores are fictional; there are no API or model calls, real backtests or optimization.

All eight agents use **SPY · S&P 500 ETF** as the illustrative target, regardless of the Markets selection. No SPY prices are loaded or required. Each card shows its scripted Buy/Sell conditions and a **Demo signal**. Select an agent to inspect **TESTED CONDITIONS · DEMO**, its hold rule, exposure limits and an **Example signal** with sample values. These are authored explanations, not conditions evaluated on saved prices or rules sent to Backtest.

For example, A1 starts with EMA20 crossing above/below EMA80; A5 starts with RSI14 crossing above 30 to buy and RSI14 at least 70 to sell. The later M2 variant buys when the 90-day return is positive and the close exceeds SMA60 × 1.02, sells when the return is nonpositive or the close is at or below SMA60, and otherwise holds. Its example close of 101 lies between an exit threshold of 100 and an entry threshold of 102, producing a scripted Hold. Candidate metrics are invented independently of these conditions; a reference candidate's figures are not a measured result for a specialist's current test.

The workspace combines playback controls, the current phase, an eight-agent arena, an activity-following inspector, the latest three messages and a four-candidate comparison table. **Branching lineage** shows parent/child relationships, growing to all twelve candidates; **Current cause** explains the latest event. The illustrative score is 0.6 × CAGR − 0.4 × |MDD| with arbitrary weights. M2 leads that score, while M3 has higher CAGR and D2 lower drawdown; none is a validated winner.

Navigate with **Play scene / Pause / Replay**, **Next event**, speed, timeline and chapter controls. Select an agent to inspect its task and received messages; use **Follow activity** to resume automatic tracking. Swarm has no chat. Leaving pauses playback; the existing conversation and unsent draft reappear **only when returning to Markets**.

Historical layout checks recorded controls and core content fitting without scrolling at 1366×768, 1440×900, 1920×1080 and 800×1000. Those checks predate later presentation changes and are not new verification of the current condition cards. Phone widths of 600px or less allow scrolling. Icons are fixed SVGs bundled with the app, not fetched from an external service at runtime. Sources and usage terms are in [ui/gui/avatars/README.md](../ui/gui/avatars/README.md).

## Export result JSON

Use **Download result JSON** to export correlation, event-study or backtest results. The desktop permits only user-initiated, same-origin JSON blob downloads from the app and uses the native save dialog. Files must have a known size greater than zero and at most 8 MiB, with an allowed result filename. Automatic and external-origin downloads are blocked. Canceling the save does not change the calculation result. This exports a result; it is not research-run bundle storage or replay.

## Inspect market data sources

Open **Sources & provenance** to inspect the provider, collection time, archive ID and raw-file hashes. In Guru or Swarm, this control still opens saved Yahoo provenance, not that workspace's source.

An **archive** stores one market-data download together with its provenance. Each collection has a distinct ID, identifying which saved source produced a value even when dates match.

A **hash** is a fingerprint calculated from file contents. Comparing it with the saved fingerprint detects changes, but a matching hash does not prove price accuracy, source authenticity or an external audit.

## Connect Copilot and ask questions

**Ask Copilot** appears **only in Markets** because it receives the selected asset's saved data from archive start through the pinned date—not Backtest results, correlation, event studies, Guru data or Swarm state. Other workspaces hide the existing chat panel and reclaim its desktop sidebar or narrow-window bottom space. The same chat nodes, history and unsent draft are retained for the return to Markets. Chat answers do not activate rules or run backtests; rule generation is available only through **Backtest / Generate rules**.

Topbar **Settings**, available from every workspace, is the sole setup entry. Open it, select **Check connection**, then choose a model. Chat and Backtest have no separate connection buttons. Opening Settings sends no request. A connection check reads authentication and the account's model list only, without model inference or market-data transmission. Sending questions and generating rules require a ready connection and valid model selection. **Current account details** only reveals already loaded information; it does not select or switch accounts.

GitHub Copilot is the only supported AI provider. Enterprise entitlement and a separate mandatory consent checkbox are not prerequisites. Explicitly requesting analysis or rule generation with a selected model transmits the relevant data and question, subject to service and organizational data policies. An explicit refusal to share is never bypassed. User questions and model responses are not forcibly translated.

A historical, pre-redesign `gpt-5.4-mini` check preserved SMA17, RSI9, AND-entry and OR-exit semantics in repeated runs of the same Korean compound-rule example. Later recorded offline browser checks made no new model calls. This is not evidence of general Korean or multilingual generation quality, nor a guarantee that analysis answers are correct.

Selecting another chart date while composing does not automatically change the question's pinned date. Use **Use current selection** to update it. Shared data spans the selected asset's archive start through that date, not just the visible chart window.

For an external coding agent, manually copy and send the prepared request containing the pinned selection. This is also an external transfer, so first check that the service is permitted. A read-only request does not authorize downloads, installation, result writes or additional model calls.

## Limits when using results for investment research

The latest daily bar may change before the session ends, and the provider may have adjusted historical prices for events such as stock splits. Simple price changes shown in the interface exclude dividends and trading costs.

Even when costs are included, a backtest is a **price-return simulation based on the current saved archive**. It does not guarantee dividend-reinvested total returns, information actually available at each historical decision time, or inclusion of assets that later disappeared. Do not interpret it as real investment performance free of look-ahead or survivorship bias. Multiple currencies, guaranteed long-history coverage, a 30-asset universe and the reference service's full named strategy catalog remain outside the current supported scope.