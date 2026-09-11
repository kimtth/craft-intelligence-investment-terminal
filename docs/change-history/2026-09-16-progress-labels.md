# Stable backtest progress labels

Previously, each progress event replaced one status line with either Strategy or Benchmark. Interleaved events made the name alternate rapidly, and changing digit counts could shift nearby text.

The progress panel now keeps separate Strategy and Benchmark label nodes with independent completed/total counters. Fixed-width numeric slots and tabular digits stabilize the layout. The lifecycle status announces waiting, running, completion and errors; per-event counters do not trigger repeated live announcements.

Both counters reset to unknown on a new run. Updates retain backend counts without combining or fabricating them. Errors retain received counts, and final-only responses do not manufacture phase totals. The existing progress bar and chart calculations are unchanged.

Regression coverage checks alternating events, independent counters, stable label identity and digit geometry, repeated runs, final-only responses and errors. See the [progress and performance tests](../../tests/ui/performance-chart.test.js).