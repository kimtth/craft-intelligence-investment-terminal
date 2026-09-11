// Invented provider-shaped records for offline adapter and UI tests only.
import assert from 'node:assert/strict';
import { buildGuruService } from '../../../ui/guru-service.js';

const LABEL = 'TEST FIXTURE ONLY - NOT REAL PUBLIC HOLDINGS';
export function guruVerificationFixture() {
  const period = '2026-06-30', historical = '2026-03-31', cik = '0000000001';
  const returns = { '1y_total': 23.8, '3y_annualized': null, '5y_annualized': -8.7,
    inception_annualized: 12, yearly: { 2025: 1, 2026: 13.25 } };
  const fund = { cik, name: LABEL, manager: LABEL, active: 1, show_in_default: 1,
    category_en: 'Test', latest_period: period, returns_current: false,
    return_start_period: '2020-12-31', return_end_period: period, returns };
  const holding = { cusip: 'TESTONLY1', ticker: 'TEST', name: LABEL, shares: 12, value: 100,
    pct_portfolio: 100, change_type: 'INC', pct_change: null, prev_shares: 10 };
  const payloads = {
    funds: { funds: [fund], note: LABEL },
    quarters: { quarters: [{ period, fund_count: 1, not_filed_count: 0 },
      { period: historical, fund_count: 1, not_filed_count: 0 }], default_period: period, total_visible_funds: 1 },
    fund: { fund, period, periods_available: [period, historical], holdings: [holding], returns,
      total_value: 100, position_count: 1, filing_status: 'filed', is_empty_filing: false,
      returns_current: false, return_start_period: '2020-12-31', return_end_period: period, note: LABEL },
    popular: { period, manager_funds: [{ ticker: 'TEST', name: LABEL, manager_count: 1, total_value: 100,
      total_shares: 12 }], fund_status: [], filed_count: 1, not_filed_count: 0, note: LABEL },
    changes: { period, changes: [{ cik, fund_name: LABEL, manager: LABEL, period, ...holding,
      new_shares: 12 }], fund_status: [], filed_count: 1, not_filed_count: 0, note: LABEL },
  };
  const requests = [];
  const service = buildGuruService({ fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://easyinvesting.app');
    assert.equal(options.method, 'GET');
    requests.push(parsed.pathname + parsed.search);
    const suffix = parsed.pathname.replace('/api/guru/', '');
    const key = suffix === `fund/${cik}/holdings` ? 'fund' : suffix === 'recent-changes' ? 'changes'
      : ['popular', 'buys', 'sells'].includes(suffix) ? 'popular' : suffix;
    assert.ok(Object.hasOwn(payloads, key), 'No unrecognized fixture endpoint or real-network fallback');
    const data = structuredClone(payloads[key]);
    if (Object.hasOwn(data, 'period')) data.period = parsed.searchParams.get('period') || period;
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  return { service, requests, payloads, period, historical, cik, label: LABEL };
}