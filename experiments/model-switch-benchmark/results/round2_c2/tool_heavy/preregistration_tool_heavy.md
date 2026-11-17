# Item 5 Pre-Registration — Tool-Heavy Paired Run (`n = 1` Exploratory)

- **Pre-registered At (UTC):** `2026-11-14T23:06:58.704Z`
- **Mode:** `live`
- **Sample Size Disclaimer:** `n=1 exploratory paired run; no statistical precision claim`
- **Design:** `12` turns, switch scheduled before `T3` (`postSwitchRemainingTurns = 9`), `anthropic/claude-opus-4.6 -> anthropic/claude-sonnet-4.6`, effort `medium`, `5m` cache TTL, upstream provider pinned to `anthropic`.
- **Predicted `requests/turn`:** `5` (acceptable band: `[3, 7]`, hard max/turn: `10`).
- **Predicted Cost (`TH_hold_r01`):** `$0.9816` (hard `2x` abort cap: `$1.9632`).
- **Predicted Cost (`TH_allow_r01`):** `$0.6915` (hard `2x` abort cap: `$1.3830`).
- **Predicted Difference (`hold - allow`):** `+$0.2901` (`~$0.30` saved by allowing switch at T3 under tool-heavy `R = 5`).
- **OpenRouter Key Before Run:** balance `$12.239478`, usage `$37.76052205`, limit `$50.00`

