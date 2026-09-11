---
name: itt-research
description: "Use for Intelligent Trading Terminal CLI: saved Yahoo lookup, criteria/portfolio backtests, correlation, event studies, manual Guru imports, GitHub Copilot analysis/rules, and progress integration."
---

# ITT agent terminal reference

Use public CLI commands and the GUI's saved archive for financial work—not private imports, screen scraping, independent math or generated-code execution. Read the [developer guide](../../../docs/02-developer-guide.md) for schemas, formulas and integration; the [user guide](../../../docs/01-user-guide.md) only for UI handoffs.

## Execute safely

- Run from repository root in the sole prepared `.venv` (Python 3.13+). Below, `<itt>` means `./.venv/Scripts/python.exe -m itt.cli` on Windows or `./.venv/bin/python -m itt.cli` on POSIX. Do not append another `cli`.
- Missing environment: report it; consult the developer guide for authorized setup. No alternate environment or stopping user-owned processes.
- Capture stdout and exit code immediately (`$LASTEXITCODE` in PowerShell), keeping stderr separate. Require exit 0 and exactly one `{ok:true,result:…}` envelope. Missing/malformed output fails. Python: exit 2 input rejection, 1 I/O failure. Node also requires operation readiness/source identity; exit 1 can occur even with `ok:true`.
- `<itt> capabilities` describes Python features, not Copilot readiness. `--help` is text; `pnpm start` launches the desktop, not JSON.
- A lookup does not authorize collection, installs or inference. Respect read-only/no-terminal limits; preserve archives/bundles. No orders, Orca or implemented MCP. Never expose secrets or invent extra approval gates.

## Saved Yahoo lookup

`<itt> market show [--store PATH]` verifies manifest/raw hashes and reads without network/fallback. Default `.itt/market` is the GUI archive. Require `result.manifest.id` to match the handoff archive ID on every read; mismatch means stop, not fetch/search/substitute. This command has no archive-ID/date/symbol selectors.

Match exactly one symbol/bar by integer provider timestamp **seconds**; verify date and `date_basis`. Read exact OHLCV strings and aligned `technicals` / `signals.observations` at the same full-array index, including definitions/reasons. Preserve nulls; never replace a selected-date value with `summary.last_price`.

Report archive ID, symbol/timestamp, provider and collected UTC, price/date basis, requested bounds, actual coverage and limitations. These are saved daily USD snapshots, not live/PIT-verified prices. `pricechange_pct` is already percent and spans first-to-last saved close, not necessarily one year. Backend `Neutral` displays as **Hold**; missing inputs remain Unavailable.

When collection is requested: `<itt> market fetch SYMBOL [SYMBOL …] [--start YYYY-MM-DD --end YYYY-MM-DD] [--store PATH]`. Accepts 1–10 unique uppercase symbols matching `[A-Z][A-Z0-9.-]{0,9}`. Supply both strict inclusive dates, start ≤ end (end `9999-12-31` rejected), or omit both for legacy `range=1y`. Explicit requests use UTC midnight through end-next-midnight exclusive, daily USD normalization. No automatic merge, full-history guarantee or fetch-on-navigation. Never repair failed reads with synthetic data.

## Prepare and run calculations

Read `<itt> schema KIND` **before** writing input. Run `<itt> market COMMAND --spec PATH [--store PATH]`; `PATH` must be a readable JSON file, not inline JSON.

| KIND → COMMAND | Contract |
|---|---|
| `criteria` → `backtest` | Required: `archive_id`, `symbol`, `start`, `end`, `initial_cash`, `fee_bps`, `slippage_bps`, `entry`, `exit`. [CriteriaSpec](../../../src/itt/criteria.py). |
| `portfolio` → `portfolio` | Replace symbol with 1–10 `weights`; positive integer `rebalance_every`; optional `allocation`, `rebalance_calendar`. [PortfolioSpec](../../../src/itt/portfolio.py). |
| `correlation` → `correlation` | 2–10 unique symbols, daily/weekly/monthly. [Analytics](../../../src/itt/analytics.py). |
| `trigger` → `trigger` | Source `symbol`, `target_symbol`, bounded condition, unique horizons 1–60 (default 1,5,20). [Analytics](../../../src/itt/analytics.py). |

Freeze archive identity, exact saved-session endpoints, rules, cash, costs, benchmark and metric definitions before evaluation. Money/costs are decimal strings. Multi-asset inputs require exact dates, timestamps, timezone/date basis and USD alignment—no intersection, filling or hidden date shifts. Inspect returned spec, contract, signals/results and limitations. Backtests return results without saving research bundles.

### Bounded criteria

- Rules: `{all:[…]}`, `{any:[…]}`, `{not:…}`, `{left,op,right}`. Operators: `gt`, `lt`, `gte`, `lte`, `eq`, `crosses_above`, `crosses_below`. Comparison left is a supported series/object, not a bare number.
- Operands: schema-listed series; `{indicator,period,lag?}` for `sma`, `ema`, `rsi`, `roc`, `return`, `volatility`; `{field,lag?}` for OHLCV; `{operation,left,right}` for add/subtract/multiply/divide. Period 1–252, lag 0–252 observed sessions.
- Prefer decimal-string constants; use the schema's numeric, depth, node and cost limits. Indicators use causal full-archive warmup. Return is fractional, ROC percent; volatility is unannualized. Detailed formulas belong in the developer guide.
- Any unavailable descendant makes the whole compound unavailable, including `any(true,null)` and `not`. Either unavailable entry/exit suppresses both actions. Reject unsupported/ambiguous intent; no heuristic approximation, eval or Python REPL.

### Backtest / portfolio

Close signals fill at next observed open within the window; integer units, long-only, no borrowing, retained cash, exit precedence, no final liquidation. Strategy and buy-and-hold share dates/costs. This is price-return simulation—not dividend total return, verified historical availability or survivorship-bias-free performance.

Portfolio weights lie in [0,1], sum in (0,1]. Fixed mode retains ineligible weight as cash and freezes unavailable quantities. Momentum ranks eligible trailing returns above `max(0,minimum_return)`, descending then symbol; top N share the original weight sum equally. No winners → cash; unavailable/unselected target zero. Zero-weight assets present in the spec remain candidates. Read schema defaults and bounds rather than assuming them.

Sessions decide at 0,N,2N. Monthly/quarterly decides at window start and first observed session of every N observed periods—not month end. Never decide on the final bar. Close-time integer targets freeze; sells precede alphabetical cash-limited buys; remainders expire. Not BAA or an optimizer.

Use engine-ledger metrics: CAGR uses 365.25/elapsed **calendar days**, with zero-day/overflow null; MDD is positive running maximum from initial cash. Both are decimal fractions. Never replace null with zero or annualize by 252.

### Correlation / event studies

Correlation uses simple returns between sampled closes. Weekly/monthly takes the last observed close of each ISO week/calendar month strictly within the window, including partial periods; no pre-window base or later endpoint. Report `sample_dates`, observations and reasons. Fewer than two returns or zero variance → null. Correlation is not causation.

Trigger treats **every true close** as an event. Outcome = target close[t+h] / target open[t+1] − 1; h=1 is next-session open-to-close. No outcomes beyond end; incomplete outcomes null, summaries use complete outcomes, win means >0. Overlaps are dependent. No fees, exit or execution model: not a tradable backtest.

## GitHub Copilot CLI

- `node ui/copilot-cli.js status` reads authentication/models only, without inference or market transmission. Use an available returned model ID; enterprise entitlement is not required.
- `node ui/copilot-cli.js analyze --symbol SYMBOL --timestamp SECONDS --archive-id UUID --model MODEL-ID --question "QUESTION"`. Replace `analyze` with `criteria` for declarative proposals.
- Require a currently accepted symbol, positive safe-integer seconds, UUID and trimmed 1–4000-character question. No Node `--store`, login/search flag or Python Copilot command. Never substitute symbols to bypass rejection.
- Explicit analysis/criteria requests authorize selected public-snapshot transmission; legacy `--consent` is optional, but API `consent:false` must be respected. No automatic inference/retries/provider fallback.
- Service rereads the default archive and checks identity. Context includes only selected-asset bars/indicators through the timestamp, definitions, restricted metadata and question—not future/other assets, chat history, Backtest/Research/Guru/Swarm, URLs or local paths. SDK tools/files/shell/MCP/web/config discovery are disabled.
- Check `contextIdentity` and source/prefix/raw/context hashes; hashes do not validate claims. Analysis is unverified provider text; criteria are bounded proposals, not proven strategies. Accept absent `supported`; reject explicit false. Missing token fields/USD cost remain unknown, not zero.

## Guru paths

**Automatic GUI feed:** a separate Node reference service, with no Python command or Yahoo dependency. Do not confuse it with manual imports. Provider returns/weights/changes are percentage points, not fractions; delayed 13F estimates are not actual fund returns or independently SEC-verified data. See the developer guide for API details.

**Manual Python:** read `<itt> schema guru`, then `<itt> market guru --spec PATH` (**no `--store`**). [GuruSpec](../../../src/itt/guru.py) takes `{filings,as_of}`; read the schema for filing/holding fields and bounds. Use actual supplied filings, not invented holdings. Amounts are decimal strings in actual USD, not thousands. Resolve duplicates and amendments upstream.

Filter `filed_at <= as_of` inclusively; compare latest/previous supplied available periods, not assumed consecutive quarters. No previous filing means unknown, not new. New/exited means row presence, not verified trades. Popularity counts exact manager IDs by CUSIP; weights cover imports only. SEC HTTPS checking is syntactic, not authenticity/fetch. Explain usual up-to-45-day lag, late/amended filings and limited long-US-equity scope. No inferred manager performance/CAGR/MDD.

## Boundaries

- CLI returns one result. For RPC/HTTP progress integration, read the developer guide; require correlated progress plus a terminal result/error. Progress alone is not success.
- Quant Swarm is fictional presentation. Synthetic commands are compatibility/accounting tools only; label them and never substitute them for saved Yahoo.
- Compare whole public CLI results using the same archive. Preserve evidence and failures; historical tests do not establish current behavior or financial validity. Claim only checks actually performed.
