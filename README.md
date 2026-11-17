# cbbtc-snapback-v2

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/hikambanjir-netizen/cbbtc-snapback-v2/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/hikambanjir-netizen/cbbtc-snapback-v2/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A deterministic, model-free cbBTC/USDC trading bot for the agent-fun/bars-replay/v1 harness. It sits in cash until the close prints at least 0.5% below its 22-bar simple moving average while also sitting within 0.4% of the 90-bar rolling low, then buys with all cash in a single leg. It sells the whole position at +1.8% over its fee-inclusive average entry price, or cuts it at −0.8%. One position at a time; no clock, no randomness, no network — the same bars always produce the same orders.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1: newline-delimited JSON on stdin (hello, one batch per bar, done) and exactly one reply per batch on stdout. Grade it on the dev window with the competition kit: `node cli/makefun.mjs grade-local --kit <kit dir> --bot <this repo> --driver docker`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=dfkzjsa3&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
