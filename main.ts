// RIPTIDE-30: capitulation-recovery bot for btc-race-24h-20261123-0511.
//
// The idea: BTC's 1-minute cbBTC/USDC price falls in short, sharp washouts and
// then recovers. A slow mean-reversion buy catches the knife while it is still
// falling; a fast momentum buy catches every whipsaw. This bot waits for a
// washout to be *over* before it buys:
//
//   - Arm: the close is at least 0.85% below the close 30 bars ago.
//     The arm clears, with no trade, if the 30-bar return recovers above -0.2%.
//   - Entry: once armed, buy all-in the first time the close prints above the
//     10-bar EMA (the turn, not the knife). One entry per washout.
//   - Exit, whichever comes first: take-profit at entry +2.0%, stop at entry
//     -1.0%, trailing stop 1.5% below the highest close since entry, or 600
//     bars held (10 hours). Then a 120-bar cooldown before the next entry.
//   - Late fallback: if no trade has filled by bar 1080, enter once on a close
//     above the 240-bar SMA, with the same exits. A window with no washout
//     would otherwise end with zero trades, which ranks below every entry
//     that meets the guardrails; the fallback costs nothing on the windows
//     measured (it never fired there) and buys that insurance.
//
// Why these numbers: measured offline on THREE frozen 24h dev windows (the
// new 23 Nov window plus the 17 Nov and 18 Nov windows), with a fill model
// faithful to RULES.txt (4 bps fee, 2 bps slippage, constant-product impact
// vs the fill bar's open depth, 1-bar latency, 100 bps max slippage):
//   - Bollinger mean reversion: positive on the new window and on 17 Nov,
//     negative on EVERY tested setting on 18 Nov (a falling window).
//   - EMA cross and Donchian: negative on all three windows.
//   - This family: positive on all three windows at the chosen point
//     (new +$19.63, 17 Nov +$17.30, 18 Nov +$17.84), and 701 of 3240
//     neighbouring settings are positive on all three, 464 with every window
//     above +$5 — the edge belongs to the regime, not to one tuned point.
// The chosen point sits in the middle of that plateau (arm 0.85% is between
// the 0.8% and 0.9% settings, which score identically).
//
// Deterministic: float64 EMA/SMA on closes only, integer bigint amounts,
// no clock, no environment, no randomness. Every run on the same bars gives
// the same orders.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;

/** Washout arm: close down this much vs the close ARM_WINDOW bars ago. */
const ARM_DROP = 0.0085;
/** Bars back the arm looks. */
const ARM_WINDOW = 30;
/** The arm clears if the ARM_WINDOW-bar return recovers above this. */
const ARM_CLEAR = -0.002;
/** Entry trigger: the close above this EMA span. */
const EMA_SPAN = 10;
/** Take-profit above the entry close. */
const TAKE_PROFIT = 0.02;
/** Stop below the entry close. */
const STOP_LOSS = 0.01;
/** Trailing stop below the highest close since entry. */
const TRAIL = 0.015;
/** Longest a position is held, in bars. */
const MAX_HOLD_BARS = 600;
/** Bars with no new entry after a sell. */
const COOLDOWN_BARS = 120;
/** The late fallback may fire from this bar on, if no trade has filled yet. */
const FALLBACK_BAR = 1080;
/** The fallback stops firing here: an entry later than this has too little
 *  time left to reach its exits and would mostly pay the round-trip cost
 *  for nothing (the final flatten sells it at the last close anyway). */
const FALLBACK_LAST_BAR = 1320;
/** The fallback's trend filter: the close above this SMA span. */
const FALLBACK_SMA_SPAN = 240;

const closes: number[] = [];
let emaValue: number | null = null;
const emaWarm: number[] = [];
let smaSum = 0;

let armed = false;
let entryClose = 0;
let peakClose = 0;
let entryBar = -1;
let lastSellBar = -1e9;
let everTraded = false;

function pushClose(c: number): void {
  closes.push(c);
  if (emaValue !== null) {
    emaValue += (2 / (EMA_SPAN + 1)) * (c - emaValue);
  } else {
    emaWarm.push(c);
    if (emaWarm.length === EMA_SPAN) emaValue = emaWarm.reduce((a, x) => a + x, 0) / EMA_SPAN;
  }
  smaSum += c;
  if (closes.length > FALLBACK_SMA_SPAN) smaSum -= closes[closes.length - 1 - FALLBACK_SMA_SPAN];
}

function sma240(): number | null {
  if (closes.length < FALLBACK_SMA_SPAN) return null;
  return smaSum / FALLBACK_SMA_SPAN;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    for (const fill of batch.fills) {
      if (fill.status === 'filled') everTraded = true;
    }
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const c = Number(bar.c);
    pushClose(c);
    const i = closes.length - 1;

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      if (c > peakClose) peakClose = c;
      if (entryClose > 0) {
        if (
          c >= entryClose * (1 + TAKE_PROFIT) ||
          c <= entryClose * (1 - STOP_LOSS) ||
          c <= peakClose * (1 - TRAIL) ||
          i - entryBar >= MAX_HOLD_BARS
        ) {
          lastSellBar = i;
          entryClose = 0;
          const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
          return [sell];
        }
      }
      return [];
    }

    if (i - lastSellBar < COOLDOWN_BARS) return [];

    // Arm on a 30-bar washout; clear the arm if the drop recovers.
    if (i >= ARM_WINDOW) {
      const drop = (closes[i - ARM_WINDOW] - c) / closes[i - ARM_WINDOW];
      if (drop >= ARM_DROP) armed = true;
      else if (drop <= -ARM_CLEAR) armed = false;
    }

    if (armed && emaValue !== null && c > emaValue) {
      armed = false;
      entryClose = c;
      peakClose = c;
      entryBar = i;
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }

    // Late fallback: no fill yet and the window is nearly over — enter once
    // on a close above the 240-bar SMA, with the same exits. It stops firing
    // at FALLBACK_LAST_BAR: later than that a position has too little time
    // left to reach its exits.
    if (!everTraded && i >= FALLBACK_BAR && i <= FALLBACK_LAST_BAR) {
      const s = sma240();
      if (s !== null && c > s) {
        entryClose = c;
        peakClose = c;
        entryBar = i;
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
    }

    return [];
  },
});
