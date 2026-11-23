[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511) [![Rank](https://make.fun/badge/btc-race-24h-20261123-0511/pattrap-motor/btc-race-24h-20261123-0511-entry/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511) [![Reward](https://make.fun/badge/btc-race-24h-20261123-0511/pattrap-motor/btc-race-24h-20261123-0511-entry/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

# RIPTIDE-30 — BTC trading bot for make.fun

A capitulation-recovery bot that trades Coinbase Wrapped BTC (cbBTC) against
USDC, minute by minute, on [make.fun](https://make.fun/bounty/btc-race-24h-20261123-0511).

## Strategy

Bitcoin's 1-minute price falls in short, sharp washouts and then recovers.
This bot waits for a washout to be *over* before it buys:

- **Arm:** the close is at least 0.85% below the close 30 bars ago. The arm
  clears, with no trade, if the 30-bar return recovers above −0.2%.
- **Entry:** once armed, buy all-in the first time the close prints above the
  10-bar EMA (the turn, not the knife). One entry per washout.
- **Exit, whichever comes first:** take-profit at entry +2.0%, stop at entry
  −1.0%, trailing stop 1.5% below the highest close since entry, or 600 bars
  held. Then a 120-bar cooldown before the next entry.
- **Late fallback:** if no trade has filled by bar 1080, enter once on a close
  above the 240-bar SMA, with the same exits — a window with no washout would
  otherwise end with zero trades, which ranks below every entry that meets
  the guardrails.

## Measured results (offline, three frozen 24h dev windows)

The fill model follows the competition rules exactly (4 bps fee, 2 bps
slippage, constant-product impact against the fill bar's open depth, 1-bar
latency, 100 bps max slippage):

| Window | Net PnL | Trades | Max drawdown |
| --- | --- | --- | --- |
| 23 Nov 2026 (this competition's dev window) | +$19.63 | 4 | 1.26% |
| 17 Nov 2026 | +$17.30 | 2 | 0.66% |
| 18 Nov 2026 | +$17.84 | 2 | 1.49% |

For comparison, on the same windows: Bollinger mean reversion loses on the
18 Nov window at every tested setting, EMA cross loses $107–$177, and
buy-and-hold loses $31.63 on 18 Nov. 701 of 3240 neighbouring settings of
this strategy are positive on all three windows, so the edge belongs to the
regime, not to one tuned point.

## Files

- `main.ts` — the bot (Node 22, standard library only, deterministic)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's SDK shim
- `LICENSE` — MIT
