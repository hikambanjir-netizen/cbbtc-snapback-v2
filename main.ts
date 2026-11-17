// cbbtc-snapback-v2 — a deterministic, model-free dip-buying bot for the
// agent-fun/bars-replay/v1 harness (cbBTC/USDC, one-minute bars).
//
// Idea: cbBTC spends most of a day drifting in a range, and the sharpest
// short-term edges in that range are snap-backs from local capitulation
// prints. The bot therefore waits in cash for a very specific shape — a
// close that is both stretched below its short moving average AND pinned
// near the multi-hour low — and only then commits everything in one leg.
// It is all-in / all-out with a single open position, fixed percentage
// exits, and no state beyond the two rolling windows below, so the same
// bars always produce the same orders: no clock, no randomness, no I/O
// beyond the protocol itself.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

/** The only traded symbol in this competition's universe. */
const SYMBOL = 'CBBTC';

/** Bars in the short simple moving average of closes (the stretch gauge). */
const SMA_LEN = 22;
/** Bars in the rolling-low window (the "near the floor" gauge). */
const LOW_LEN = 90;

/** Entry stretch: the close must sit at least this far under the SMA. */
const DIP_BPS = 50n; // 0.50%
/** Entry proximity: the close must be within this much above the rolling low. */
const NEAR_LOW_BPS = 40n; // 0.40%
/** Take-profit: exit the whole position this far over the average entry. */
const TP_BPS = 180n; // +1.80%
/** Stop: exit the whole position this far under the average entry. */
const STOP_BPS = 80n; // -0.80%

/** Slippage budget named on every order; fills model 2 bps plus impact. */
const MAX_SLIPPAGE_BPS = 100;

/** Smallest buy the market accepts (1 USDC in quote units). */
const MIN_NOTIONAL = 1_000_000n;

/** Basis-point denominator as a bigint, for exact integer comparisons. */
const BPS_DEN = 10_000n;

// ---------------------------------------------------------------------------
// Rolling history. BarsState keeps only each symbol's latest bar, so the bot
// keeps the two windows it needs itself: the closes for the moving average
// and the lows for the rolling floor. Both are plain arrays used as queues;
// a window is only consulted once it holds its full length of bars, so the
// first possible signal needs LOW_LEN bars of history behind it.
// ---------------------------------------------------------------------------

const closes: bigint[] = [];
const lows: bigint[] = [];

/** Append one bar's close and low, trimming both windows to their lengths. */
function pushBar(close: bigint, low: bigint): void {
  closes.push(close);
  if (closes.length > SMA_LEN) closes.shift();
  lows.push(low);
  if (lows.length > LOW_LEN) lows.shift();
}

/** Sum of the closes currently in the SMA window. */
function smaSum(): bigint {
  let total = 0n;
  for (const c of closes) total += c;
  return total;
}

/** The lowest low currently in the rolling-low window. */
function rollingLow(): bigint {
  let floor = lows[0]!;
  for (const l of lows) if (l < floor) floor = l;
  return floor;
}

/**
 * The entry shape, tested with exact integer arithmetic so no float ever
 * rounds a borderline bar the wrong way:
 *   (a) close at least DIP_BPS under the SMA of the last SMA_LEN closes
 *       (the current close included):
 *         close * SMA_LEN * BPS_DEN <= smaSum * (BPS_DEN - DIP_BPS)
 *   (b) close within NEAR_LOW_BPS above the LOW_LEN-bar rolling low:
 *         close * BPS_DEN <= rollingLow * (BPS_DEN + NEAR_LOW_BPS)
 */
function entryShape(close: bigint): boolean {
  if (closes.length < SMA_LEN || lows.length < LOW_LEN) return false;
  const stretched = close * BigInt(SMA_LEN) * BPS_DEN <= smaSum() * (BPS_DEN - DIP_BPS);
  if (!stretched) return false;
  const nearFloor = close * BPS_DEN <= rollingLow() * (BPS_DEN + NEAR_LOW_BPS);
  return nearFloor;
}

/**
 * Decide the entry order for a batch. Called only when the account is flat
 * and trading is open: if the fresh bar completes the entry shape, spend
 * every unit of cash in a single buy. While a buy decided on the previous
 * bar is filling, the account it lands in already shows the position, so
 * this can never double-fire on consecutive bars.
 */
function entryOrder(state: BarsState, close: bigint): OrderInput[] {
  if (!entryShape(close)) return [];
  const cash = state.cash;
  if (cash < MIN_NOTIONAL) return [];
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

/**
 * The fee-inclusive average entry price of the open position, as an exact
 * fraction (numerator / denominator) in the symbol's price units. The
 * account's cost basis already includes the buy fill's fee, slippage and
 * price impact, and BarsState's value() relation inverts directly:
 *   cost = qty * price * 10^quoteScale / 10^(qtyScale + priceScale)
 * so price = cost * 10^(qtyScale + priceScale) / (qty * 10^quoteScale).
 * Keeping it as a fraction lets the exit tests below stay in integers.
 */
function entryPrice(state: BarsState): { num: bigint; den: bigint } | null {
  const pos = state.positions.get(SYMBOL);
  const meta = state.symbols.get(SYMBOL);
  if (pos === undefined || meta === undefined || pos.qty === 0n) return null;
  const num = pos.cost * 10n ** BigInt(meta.qty_scale + meta.price_scale);
  const den = pos.qty * 10n ** BigInt(state.hello.capital.quote_scale);
  return { num, den };
}

/**
 * Decide the exit order for a batch. Called only while a position is open:
 * sell the whole quantity when the fresh close reaches TP_BPS over the
 * average entry, or STOP_BPS under it — whichever the bar touches. There
 * is deliberately no time-based exit: a position that goes nowhere is
 * closed by the replay's end-of-window flattening, not by the bot.
 */
function exitOrder(state: BarsState, close: bigint): OrderInput[] {
  const pos = state.positions.get(SYMBOL);
  const entry = entryPrice(state);
  if (pos === undefined || entry === null) return [];
  const lhs = close * entry.den * BPS_DEN;
  const takeProfit = lhs >= entry.num * (BPS_DEN + TP_BPS);
  const stoppedOut = lhs <= entry.num * (BPS_DEN - STOP_BPS);
  if (!takeProfit && !stoppedOut) return [];
  return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

/**
 * One batch, one decision. The batch's own CBBTC bar is the only fresh
 * information: when the symbol is absent from a batch there is no new
 * close to judge, the windows stay untouched and the reply is empty. A
 * present bar is folded into the windows first, so both gauges include
 * the bar being decided on. Warm-up batches build history but never
 * trade. A held position is judged for exit; a flat account for entry.
 */
function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return [];
  const close = BigInt(bar.c);
  pushBar(close, BigInt(bar.l));
  if (state.warmingUp) return [];
  if (state.positions.has(SYMBOL)) return exitOrder(state, close);
  return entryOrder(state, close);
}

await runBars({ onBatch });

