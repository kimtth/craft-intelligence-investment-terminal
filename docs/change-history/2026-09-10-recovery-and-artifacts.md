# Recovery checkpoint and retained artifact provenance

Historical record, **2026-09-10**. This is not current installation guidance or a product-completion report. Current guidance is in the [developer guide](../02-developer-guide.md).

## External pre-rewrite checkpoint

The checkpoint is outside this repository at **D:/Code/iit-checkpoints/20260910-pre-rewrite**. It contains first-party.zip, manifest.json, source, and restore-verified. These external paths are not checkout-relative links.

- **42 first-party source/configuration/README files** were compared by SHA256 across the original, copied source, and ZIP restoration. All 42 matched again immediately before replacement.
- ZIP SHA256: **CB734FF4B777B29612267C1C09B7D87848D50B97217BDF8C8B06F23089A61005**.
- The manifest records the exact file list, reference-repository HEAD/status, and preserved document/Git-file hashes. Environments, credentials, and reference repositories are not included in the ZIP.
- At checkpoint creation, no recoverable commit was found in the local Git history/reflog/fsck inspection. Do not assume Git can restore these files. This is a historical observation, not a claim about today's Git state.
- The replacement removed 41 old first-party paths; README was retained and rewritten. Reference repositories, Git metadata, existing environments, and raw artifacts were preserved. Do not repeat the initial deletion/rewrite.

**Recovery procedure:** first preserve the current working files separately. Extract the ZIP into an **empty directory**, verify the manifest hashes, then copy only the specifically needed files after review. Do not extract over the current repository, overwrite the checkpoint, or use a destructive reset. This local checkpoint is not an off-device backup.

## Retained recording provenance

These records distinguish old recordings from the new desktop-video deliverable. Do not delete or relabel the artifacts.

| Artifact | Identity and interpretation |
|---|---|
| [TUI verification](../../output/real-market-cce66c09-b0cf-4d52-a8a3-1119006c9c5f/verification.json) and [market provenance](../../output/real-market-cce66c09-b0cf-4d52-a8a3-1119006c9c5f/market-provenance.json) | ConPTY TUI price-lookup recording, not the current desktop UI. Archive `e3d19851-8647-4389-b3ab-244bf848fb2c`, collected `2026-09-10T04:09:49.215009Z`; 251 bars per symbol, 2025-09-10 through 2026-09-09. Date basis `UTC_fallback_exchange_timezone_unavailable`. Twelve interaction checks were recorded; 120 seconds was a target, not an independently recorded duration measurement. |
| [Earlier failed capture provenance](../../output/real-market-02789e26-600d-48f5-8e5e-86cfaa7e4695/market-provenance.json) | Retained failed capture; not a deliverable. |
| [Browser verification report](../../output/gui-technical-verification/report.json) | Browser GUI recording, not Electron footage. The recorded final-CSS run was `2026-09-10T07:01:29.102Z`, archive `6e631bd3-c254-4e9d-981b-ce3324fdeea9`, QQQ timestamp `1788269400`. Its WebM was page@d4ef5e440df6321aa6ea53b10420ae6d.webm. |

The browser MP4 named actual-gui-interactions.mp4 was a **4.92-second, 1600×1000 H.264 smoke recording**, derived from the separate pre-final-CSS WebM page@c53735857c026c7a11dab1fca869d898.webm. It is not the report's final-CSS recording and is not a 120-second contest or desktop video. The TUI MP4's recorded SHA256 was **4022933379a389df23edf427bb1491d898c963ff5a91208a2960102a75cb273d**; these historical hashes were not recomputed during documentation cleanup.

## Retained development evidence

- Synthetic CLI evaluation report identifier: `3628b587-493d-4b5c-8c94-d9a8eef6143d`, under the local ignored evaluation store. It records six cases, eight sensitivity cases and ten saved runs with engine 0.2.1; not investment performance.
- Explicit VS Code Skill-to-public-CLI evaluation used store identifier `0e1c84d1-1f36-4985-9536-dde73a4f2a20`, run `c9cb584b-b333-47f4-a221-712be0adc1c6`, and note `54541c22-b472-444c-ad13-21b119d017fd`. This was explicit file loading, not automatic Skill discovery or app inference.
- Preserve older-engine bundles, including 0.2.0 artifacts. A current replay version mismatch does not establish corruption and is not permission to migrate, overwrite, or delete a bundle.

The active storage defect is described in the [developer guide](../02-developer-guide.md), not in a troubleshooting timeline. Recording preservation grants no publication or submission permission.