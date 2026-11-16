# What the Evidence Actually Says About Technical Indicators

A literature review written for a tool that draws moving averages, MACD, RSI, ATR bands and stop lines. The purpose of this document is to keep the tool honest: what is well established, what is genuinely contested, and what is folklore that survives because it is easy to draw on a chart.

**Compiled 2026-11-15.** Every claim below carries a source link. Where the evidence is thin, contradictory, or rests on a single paper, the verdict says so.

---

## How to read the strength labels

| Label | Meaning |
|---|---|
| **Strong** | Multiple independent studies, large samples, survives out-of-sample and after costs, or is arithmetic rather than empirical. |
| **Moderate** | More than one credible study agrees, but the effect is small, regime-dependent, or sensitive to implementation. |
| **Weak** | One or two studies, narrow samples, no independent replication, or results that vanish after realistic costs. Treat as a hypothesis, not a fact. |

A "weak" label does not mean "false". It means the published record does not support acting on it with confidence.

---

## Summary of verdicts

| # | Topic | Verdict | One-line finding |
|---|---|---|---|
| 1 | Time-series momentum / trend following | **Moderate** | Real and persistent across a century of futures data, but modest, time-varying, and statistically contested at the individual-asset level. |
| 2 | Moving-average and MACD crossovers | **Weak** | Historically profitable in-sample; the profits do not survive data-snooping corrections and transaction costs in most studies. Useful mainly as a regime filter. |
| 3 | RSI mean reversion, multi-day | **Weak–moderate** | Short-horizon reversal is real in equity indices at 3–10 days, but small, episodic, and easily eaten by costs; deep oversold can persist for months. |
| 4 | Volatility/ATR sizing and stops | **Moderate** (risk) / **Weak** (return) | Inverse-volatility sizing reliably reduces tail risk and equalises risk across regimes; it does not reliably add return. Stop-losses help in momentum regimes and hurt in mean-reverting ones. |
| 5 | Triple-barrier labelling | **Moderate** as method, **weak** as edge | It aligns labels with the actual trading rule and prevents some self-deception; no published evidence that it creates predictive power. |
| 6 | Transaction costs and retail failure | **Strong** | Costs and turnover are the most reliable predictors of strategy failure; most active retail traders underperform after costs. |
| 7 | Signal-to-noise, base rates, risk of ruin | **Strong** | Daily returns are ~20:1 noise-to-signal; hit rate without payoff ratio is meaningless; overbetting a positive edge still ruins you. |

---

## 1. Time-series momentum and trend following

**What the literature says.** The foundational paper is Moskowitz, Ooi and Pedersen, ["Time Series Momentum"](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum) (*Journal of Financial Economics*, 2012). Using 58 futures and forward contracts across equity indices, currencies, commodities and sovereign bonds over more than 25 years, they find that an instrument's own past 12-month excess return positively predicts its next-month return, that the effect "persists for about a year and then partially reverses over longer horizons", and that it is positive "for every asset contract we examine". They are explicit that this is distinct from cross-sectional momentum: it is the asset's own history, not its rank against peers.

The strongest long-horizon evidence is Hurst, Ooi and Pedersen, ["A Century of Evidence on Trend-Following Investing"](https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing) (*Journal of Portfolio Management*, 2017). They extend the sample back to 1880 and report that "in each decade since 1880, time series momentum has delivered positive average returns with low correlations to traditional asset classes", that it performed well in 8 of the 10 largest 60/40 drawdowns of the century, and that it worked across recessions, wars, and both high- and low-inflation regimes. That is about as robust as empirical finance gets — with the caveat that the pre-1985 data are reconstructed from imperfect historical sources, and the authors are employees of a firm that manages trend-following strategies.

**What is contested.** Huang, Li, Wang and Zhou, ["Time-Series Momentum: Is It There?"](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3165284) (*JFE*, 2020) is the direct challenge. They run the regression asset by asset rather than pooled, and report that they "reveal little evidence of TSM, both in- and out-of-sample". The impressive pooled t-statistic, they argue, "is not statistically reliable as it is less than the critical values of parametric and nonparametric bootstraps". Their most damaging point is economic: the TSM strategy is profitable, but "its performance is virtually the same as that of a similar strategy that is based on historical sample mean and does not require predictability". In other words, a large part of what looks like trend-following alpha may be the equity risk premium plus volatility scaling in disguise.

Baltas and Kosowski, ["Demystifying Time-Series Momentum Strategies"](https://doi.org/10.1002/9781119599364.ch3), add that measured performance is sensitive to the volatility estimator, the weighting scheme and the asset universe — implementation details that a simple 200-day moving average ignores entirely.

**What this means for a chart tool.** Time-series momentum is a real phenomenon at the portfolio level, in diversified futures, over multi-year horizons. It is *not* a per-chart law. The gap between "trend following delivers a modest, diversifying return stream at the portfolio level" and "this stock is above its 200-day average so it will go up" is enormous, and most of the academic evidence lives on the portfolio side of that gap.

**Verdict: Moderate.** Real, century-deep, and economically meaningful as a diversifier; statistically contested asset-by-asset; weak as a single-name timing signal.

---

## 2. Moving-average and MACD crossovers

**The classic positive result.** Brock, Lakonishok and LeBaron, ["Simple Technical Trading Rules and the Stochastic Properties of Stock Returns"](https://doi.org/10.1111/j.1540-6261.1992.tb04681.x) (*Journal of Finance*, 1992), tested 10 moving-average rules and 6 trading-range break rules on the Dow Jones Industrial Average from 1897 to 1986. They found that the rules had predictive content: buy signals were followed by higher average returns and lower volatility than sell signals. This paper is the empirical foundation of most retail MA lore, and it is genuinely positive. It is also, by the authors' own admission, a test bed for how easily such results can be an artefact.

**The correction.** Sullivan, Timmermann and White, ["Data-Snooping, Technical Trading Rule Performance, and the Bootstrap"](https://doi.org/10.1111/0022-1082.00163) (*Journal of Finance*, 1999), took the same universe of rules — thousands of specifications — and applied White's Reality Check to control for the fact that the best rule was chosen after looking at the data. Their conclusion: once you account for the number of rules tried, the best rule's out-of-sample performance is not statistically significant. The appearance of profitability in Brock et al. is consistent with selecting the winner from a very large pool.

Bajgrowicz and Scaillet, ["Technical Trading Revisited: False Discoveries, Persistence Tests, and Transaction Costs"](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1095202) (*JFE*, 2012), push further using the False Discovery Rate on DJIA daily data from 1897 to 2011. Two findings matter. First, "persistence tests show that, even with the more powerful FDR technique, an investor would never have been able to select ex ante the future best-performing rules." Second, "even in-sample, the performance is completely offset by the introduction of low transaction costs." That is the cleanest statement of the problem: the rules that worked were only identifiable after the fact, and their edge was smaller than the cost of trading them.

Marshall, Cahan and Cahan, ["Does intraday technical analysis in the U.S. equity market have value?"](https://doi.org/10.1016/j.jempfin.2006.05.003) (*Journal of Empirical Finance*, 2008), test MA rules on intraday data for DJIA constituents and find no value after costs — the higher the frequency, the worse the cost problem.

**The nuanced middle.** Lo, Mamaysky and Wang, ["Foundations of Technical Analysis"](https://doi.org/10.1111/0022-1082.00265) (*Journal of Finance*, 2000), use kernel regression to identify patterns automatically in US stocks from 1962 to 1996 and conclude that several indicators, including moving averages and RSI-style oscillators, "provide incremental information" that is statistically detectable — while cautioning that statistical detectability is not the same as economic profit. Zhu and Zhou, ["Technical analysis: An asset allocation perspective on the use of moving averages"](https://doi.org/10.1016/j.jfineco.2008.07.002) (*JFE*, 2009), supply a theoretical reason MA rules can be optimal: when expected returns are time-varying and unknown, a moving average is a sensible estimator of the conditional mean, so MA timing improves asset allocation even in a rational framework.

**MACD and RSI specifically.** The peer-reviewed literature is thinner than for moving averages. Chong and Ng, ["Revisiting the Performance of MACD and RSI Oscillators"](https://www.mdpi.com/1911-8074/7/1/1) (*Journal of Risk and Financial Management*, 2014), test the classic parameter sets across five OECD markets. They find MACD(12,26,0) and RSI(21,50) "consistently generate significant abnormal returns in the Milan Comit General and the S&P/TSX Composite Index", and RSI(14,30/70) profitable in the Dow Jones Industrials — but the results do **not** hold across all five markets. Market-specific, parameter-specific, and the paper does not model transaction costs. That is a fair summary of the MACD literature: occasional positive findings in particular markets and periods, no consistent replication.

**Verdict: Weak** for standalone crossover signals. The honest use of a moving average is as a *state variable* — "is the trend up or down, and how much risk should I take" — not as a signal generator with an implied win rate.

---

## 3. RSI mean reversion at multi-day horizons

**What RSI actually is.** J. Welles Wilder introduced the Relative Strength Index in [*New Concepts in Technical Trading Systems*](https://archive.org/details/newconceptsintec00wild) (1978), the same book that introduced ATR and ADX. RSI is a normalized momentum oscillator: 100 minus 100/(1+RS), where RS is average gain over average loss, smoothed. The 14-period lookback and the 30/70 thresholds are Wilder's conventions, not derived from any optimisation.

**The problem with citing "RSI works".** There is no body of peer-reviewed evidence validating RSI(14) with 30/70 thresholds as a predictive signal on US equities. The instrument has been tested (Chong and Ng find RSI(14,30/70) profitable in the DJIA over their sample), but the specific claim retail traders make — "RSI below 30 means it bounces" — is not a tested proposition in the academic literature.

**The closest thing that *is* tested: short-horizon reversal.** Jegadeesh, ["Evidence of Predictable Behavior of Security Returns"](https://doi.org/10.1111/j.1540-6261.1990.tb05110.x) (*Journal of Finance*, 1990), and Lehmann, ["Fads, Martingales, and Market Efficiency"](https://www.nber.org/papers/w2533) (*QJE*, 1990), document that individual stocks that have fallen over the past week or month tend to rebound over the next. That is the empirical phenomenon RSI is trying to capture, and it is real — but it is a *cross-sectional* effect on individual stocks, not a timing rule for an index.

**The catch.** Nagel, ["Evaporating Liquidity"](https://www.nber.org/papers/w17653) (*Review of Financial Studies*, 2012), shows that short-term reversal returns are "a proxy for the returns from liquidity provision": they are compensation for supplying liquidity when it is scarce, they spike with the VIX, and their conditional Sharpe ratios rise enormously in crises. That is a business model (market making), not a signal you can harvest by buying an oversold index with a retail account. Avellaneda and Lee, ["Statistical arbitrage in the US equities market"](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1153505) (*Quantitative Finance*, 2010), make the same point quantitatively: their PCA-based mean-reversion strategies earned a Sharpe ratio of 1.44 from 1997 to 2007 after costs, but only 0.9 from 2003 to 2007, and the strategy requires hundreds of simultaneous positions, daily rebalancing and institutional execution.

**Verdict: Weak–moderate.** Multi-day mean reversion in equity indices is visible in the data (see §8), but it is small, episodic, concentrated in high-volatility regimes, and decays quickly with costs. The specific "RSI(14) < 30 is a buy" rule is folklore with a plausible mechanism behind it, not an established result.

---

## 4. Volatility/ATR-based position sizing and stop placement

This is two questions that are usually conflated: *how big should the position be* (sizing) and *when should I get out* (stops).

**Sizing: the strongest result in this document's risk section.** Moreira and Muir, ["Volatility-Managed Portfolios"](https://www.nber.org/papers/w22208) (*Journal of Finance*, 2017), show that scaling exposure inversely to recent volatility "produce[s] large alphas, substantially increase[s] factor Sharpe ratios, and produce[s] large utility gains" across market, value, momentum, profitability and carry factors. Harvey, Hoyle, Korgaonkar, Rattray, Sargaison and van Hemert, ["The Impact of Volatility Targeting"](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3175538) (*Journal of Portfolio Management*, 2018), refine the claim: volatility targeting improves Sharpe ratios for "risk assets" such as equity and credit (because of the leverage effect) but has "negligible" impact for bonds, currencies and commodities, while across all asset classes it "reduces the likelihood of extreme returns" and makes left-tail events less severe.

**But it is contested out of sample.** Cederburg, O'Doherty, Wang and Yan, ["On the performance of volatility-managed portfolios"](https://doi.org/10.1016/j.jfineco.2020.04.015) (*JFE*, 2020), test 103 equity strategies and find that "volatility-managed portfolios do not systematically outperform their corresponding unmanaged portfolios in direct comparisons", and that "reasonable out-of-sample versions generally earn lower certainty equivalent returns and Sharpe ratios". Their explanation is structural instability in the spanning regressions — the relationship you estimate in one period does not hold in the next.

**Stops: conditional, not universally good.** Kaminski and Lo, ["When Do Stop-Loss Rules Stop Losses?"](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=968338) (*Journal of Financial Markets*, 2014), is the paper to know. They prove that "under the Random Walk Hypothesis, simple 0/1 stop-loss rules always decrease a strategy's expected return", but "in the presence of momentum, stop-loss rules can add value". Empirically, applying a stop-loss to a buy-and-hold US equity portfolio from 1950 to 2004, "certain stop-loss rules add 50 to 100 basis points per month to the buy-and-hold portfolio during stop-out periods". The lesson is precise: a stop is a bet that returns are momentum-like at the horizon you are stopping at. In a mean-reverting market, the same stop sells the bottom.

**ATR specifically.** ATR is Wilder's average true range — a volatility estimator, introduced in the same 1978 book. Using a multiple of ATR as a stop distance is a heuristic for making the stop proportional to normal noise, which is sensible: a fixed 2% stop means something completely different for a utility and for a biotech. But there is no peer-reviewed result establishing an optimal ATR multiple, and the "3×ATR" convention is not derived from anything.

**Verdict: Moderate for risk control, weak for return enhancement.** Inverse-volatility sizing is one of the few robust risk-management results in the literature; stop rules are conditional on the return process; ATR multiples are a reasonable heuristic with no optimality claim.

---

## 5. The triple-barrier labelling method

**What it is.** Marcos López de Prado, [*Advances in Financial Machine Learning*](https://www.wiley.com/en-us/Advances+in+Financial+Machine+Learning-p-9781119482086) (Wiley, 2018), Chapter 3, proposes labelling each observation by which of three barriers is touched first: an upper barrier (profit target), a lower barrier (stop-loss), or a vertical barrier (a maximum holding period). The label is not "did the price go up over the next N days" but "what would this trade have done", including the path.

**Why it is a genuine improvement in methodology.** Fixed-horizon labels ignore the path: a trade that is up 5% at day 2 and down 1% at day 10 gets the same label as one that drifts down the whole time. Triple-barrier labels embed the actual exit rule into the target, so the model learns the thing you will actually trade. It also enables **meta-labelling** — a second model that decides whether to act on the primary signal and how large to size it — and it makes explicit that overlapping labels need sample weights and purged, embargoed cross-validation (AFML Chapters 4 and 7), because otherwise the same information appears in train and test.

**What it is not.** It is a labelling convention, not a source of alpha. There is no published head-to-head study showing that triple-barrier labels produce better out-of-sample risk-adjusted returns than fixed-horizon labels on a public dataset. The method's value is that it makes a backtest less dishonest, not that it makes a weak signal strong. López de Prado's own framing in ["The 10 Reasons Most Machine Learning Funds Fail"](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3104816) (*Journal of Portfolio Management*, 2018) is that failure comes from research process errors — backtest overfitting, look-ahead bias, ignoring multiple testing — not from label choice.

**The multiple-testing problem it points at.** Bailey and López de Prado, ["The Deflated Sharpe Ratio"](https://doi.org/10.3905/jpm.2014.40.5.094) (*Journal of Portfolio Management*, 2014), show that a Sharpe ratio selected as the best of many trials must be deflated for the number of trials, the non-normality of returns, and the length of the sample. If you test 50 parameter combinations, the best in-sample Sharpe is inflated by roughly the expected maximum of 50 draws — which is why "I found a profitable setting" is nearly meaningless without a trial count.

**Verdict: Moderate as methodology, weak as edge.** Use it to make labels match the trading rule and to force honest cross-validation. Do not expect it to turn a mediocre signal into a good one.

---

## 6. Transaction costs, and why most retail technical strategies fail

**Costs are smaller than academics used to assume — for institutions.** Frazzini, Israel and Moskowitz, ["Trading Costs"](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3229719) (2018), use $1.7 trillion of live executions across 21 developed markets over 19 years and find "actual trading costs to be an order of magnitude smaller than previous studies suggest". For liquid large-cap US equities, all-in costs for a institutional manager are on the order of a few basis points. This is a real correction to the older literature, and it matters: it means a strategy does not need a huge edge to survive in SPY.

**But turnover still kills most signals.** Novy-Marx and Velikov, ["A Taxonomy of Anomalies and Their Trading Costs"](https://doi.org/10.1093/rfs/hhv063) (*Review of Financial Studies*, 2016), show that once realistic trading costs are applied, a large share of published anomalies lose statistical and economic significance; the ones that survive tend to be low-turnover. The arithmetic is unforgiving: a strategy that trades 100 round trips a year at 5bp per side pays 100 × 2 × 5bp = **1,000bp = 10% a year** before it earns anything. At 10bp per side it is 20%. No crossover signal on a daily chart generates that much gross edge.

**The retail evidence is brutal.** Barber and Odean, ["Trading Is Hazardous to Your Wealth"](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=219228) (*Journal of Finance*, 2000), examine 66,465 US discount-broker households from 1991 to 1996: "those that traded most earned an annual return of 11.4 percent, while the market returned 17.9 percent". The average household turned over 75% of its portfolio annually and still underperformed by more than 6 percentage points. Chague and De-Losso, ["Day Trading for a Living?"](https://doi.org/10.2139/ssrn.3423101) (2020), follow every individual who began day-trading Brazilian equity futures between 2013 and 2015 and persisted at least 300 days: **97% lost money**, only 0.4% earned more than a bank teller's wage, and "we find no evidence of learning by day trading".

**Edges decay after publication.** McLean and Pontiff, ["Does Academic Research Destroy Stock Return Predictability?"](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2156623) (*Journal of Finance*, 2016), study 97 published predictors and find returns "26% lower out-of-sample and 58% lower post-publication". Any widely known technical rule has had decades to be arbitraged.

**Verdict: Strong.** Costs, turnover and crowding are the most reliable predictors of failure. This is the finding that most retail technical strategies run into, and it is not seriously disputed.

---

## 7. Signal-to-noise, base rates, expectancy, profit factor, risk of ruin

**Daily returns are mostly noise.** Fama's [efficient-markets review](https://doi.org/10.2307/2325486) and, more concretely, Welch and Goyal, ["A Comprehensive Look at the Empirical Performance of Equity Premium Prediction"](https://doi.org/10.1093/rfs/hhm014) (*Review of Financial Studies*, 2008), show that the standard predictors of the equity premium "failed both in-sample and out-of-sample" over the prior 30 years and that out-of-sample prediction was worse than the historical mean. The point generalises: at daily horizons, the predictable component of returns is tiny relative to the variance.

The arithmetic, computed from the data in §8: the S&P 500's mean daily return over the past decade was +0.0564% with a standard deviation of 1.143% — a signal-to-noise ratio of **0.049**, or about 1:20. For the Nasdaq-100 over 41 years it is 0.040, or 1:25. Any indicator that claims to forecast the *sign* of tomorrow's return is trying to predict a quantity whose average is about 5% of its own standard deviation.

**Hit rate alone is meaningless.** Expectancy is `(win rate × average win) − (loss rate × average loss)`. A strategy that wins 90% of the time but loses 9 units when it loses has zero expectancy: 0.9 × 1 − 0.1 × 9 = 0. A strategy that wins 40% of the time with a 2:1 payoff has positive expectancy: 0.4 × 2 − 0.6 × 1 = +0.2 per unit risked. This is why "our signal is right 70% of the time" is not a claim about profitability — it is a claim about one of two inputs.

**Profit factor** — gross profit divided by gross loss — is the same information in ratio form. A profit factor of 1.2 means you earn $1.20 for every $1.00 lost, before costs; a cost load equal to that 20% margin wipes the edge out entirely. Most published technical-rule studies report gross statistics and leave this out, which is the single most common way a backtest misleads.

**Base rates are the benchmark that is usually ignored.** From the data in §8: the S&P 500 rose on **54.8%** of days over the past decade, and was positive in **8 of 10** calendar years (2017–2026). The Nasdaq-100 was positive in **33 of 40** calendar years from 1987 to 2026 — an **82%** base rate. Any rule that is short half the time is fighting that base rate; any rule that is long most of the time will look good in a bull market whether or not the indicator adds anything. A timing strategy must be compared to buy-and-hold, not to zero.

**Risk of ruin.** Kelly, ["A New Interpretation of Information Rate"](https://doi.org/10.1002/j.1538-7305.1956.tb03809.x) (1956), and Thorp, ["The Kelly Criterion in Blackjack, Sports Betting, and the Stock Market"](https://www.eecs.harvard.edu/cs286r/courses/fall12/papers/Thorpe_KellyCriterion2007.pdf) (2007), give the mathematics: with a positive edge, the growth-optimal fraction is edge/odds, and betting materially above it guarantees ruin with probability one in the long run even though every individual bet has positive expectancy. For a 55/45 coin flip at even odds, the optimal fraction is 10% of capital; betting 20% is already at the breakeven point and 30% produces a negative growth rate. Position sizing is not a detail — it determines whether a positive-expectancy strategy survives.

**Verdict: Strong.** These are mathematical identities and large-sample regularities, not contested empirical claims. They are also the part of trading education most often skipped.

---

## 8. A replication on this tool's own data

To avoid citing literature while ignoring the data in front of us, the following tests were run on the same FRED series that power this app. **This is not peer-reviewed research.** It is a sanity check: single market, single parameter set, no dividends, cash earns 0%, costs of 2bp per switch where labelled. Signals are computed on the close of day *t* and executed at the close of day *t+1*, so there is no look-ahead.

**Data:** S&P 500 daily closes 2016-11-14 → 2026-11-13 (2,513 returns); Nasdaq-100 daily closes 1986-01-02 → 2026-11-13 (10,298 returns). Source: [FRED `SP500`](https://fred.stlouisfed.org/series/SP500), [`NASDAQ100`](https://fred.stlouisfed.org/series/NASDAQ100).

### 8.1 Long/flat timing rules vs buy-and-hold

| Strategy | CAGR | Annualised vol | Max drawdown | Switches | Time in market |
|---|---|---|---|---|---|
| **S&P 500, 2016–2026** | | | | | |
| Buy and hold | +13.3% | 18.1% | −33.9% | — | 100% |
| Close > SMA(200) | +7.7% | 11.8% | −19.7% | 57 | 75% |
| Close > SMA(50) | +7.3% | 10.6% | −21.3% | 160 | 72% |
| MACD(12,26,9) > signal | +6.5% | 10.2% | −17.6% | 218 | 50% |
| **Nasdaq-100, 1986–2026** | | | | | |
| Buy and hold | +14.0% | 26.1% | −82.9% | — | 100% |
| Close > SMA(200) | +10.9% | 18.2% | −60.6% | 281 | 74% |
| Close > SMA(50) | +10.5% | 16.5% | −46.3% | 688 | 66% |
| MACD(12,26,9) > signal | +5.4% | 16.0% | −72.2% | 836 | 51% |

With 2bp per switch the S&P 500 figures become +7.6% (SMA200), +7.0% (SMA50) and +6.0% (MACD) — costs are almost irrelevant at this turnover on an index, which is the one place the retail cost problem is mild.

**Reading it honestly.** Every timing rule cut drawdowns, which is the risk-management case, and every one gave up a large amount of return in a market that went up most of the time. Return per unit of volatility: buy-and-hold 0.73 for the S&P 500, versus 0.65 for SMA200 and 0.64 for MACD. Over the Nasdaq-100's 41 years the ranking flips slightly — SMA200's 0.60 beats buy-and-hold's 0.54 — mostly because the 2000–2002 crash is in that sample. Two conclusions follow: (a) the rules are drawdown control, not alpha; (b) the result depends heavily on whether the sample contains a 2000-style crash, which is exactly the regime-dependence the literature warns about.

### 8.2 RSI forward returns

Average forward return after the condition, versus the unconditional average over the same sample.

| Market / rule | Horizon | n | Mean after signal | Unconditional | t-stat | Win rate |
|---|---|---|---|---|---|---|
| S&P 500, RSI(14)<30 | 5 days | 41 | +1.79% | +0.28% | +2.7 | 83% |
| S&P 500, RSI(14)<30 | 10 days | 41 | +1.07% | +0.55% | +0.5 | 68% |
| Nasdaq-100, RSI(14)<30 | 5 days | 172 | +1.76% | +0.32% | +3.4 | 72% |
| Nasdaq-100, RSI(14)<30 | 10 days | 171 | +2.47% | +0.63% | +3.2 | 64% |
| Nasdaq-100, RSI(2)<10 | 5 days | 1,073 | +0.75% | +0.32% | +3.5 | 61% |
| Bitcoin, RSI(14)<30 | 5 days | 148 | +2.55% | +0.92% | +1.8 | 65% |
| Bitcoin, RSI(14)<20 | 5 days | 22 | **−4.20%** | +0.92% | −2.2 | 45% |
| Bitcoin, RSI(2)<10 | 5 days | 461 | −0.09% | +0.92% | −2.0 | 54% |

**Three caveats that matter more than the numbers.** First, these are overlapping windows: 41 "events" in the S&P 500 sample are not 41 independent observations, so the t-statistics are overstated. A block bootstrap would shrink them. Second, the effect is much weaker at 10 days than at 5 in the S&P 500, which is what a short-lived liquidity bounce looks like, not a durable reversal. Third, and most importantly, **the sign flips in Bitcoin**: RSI below 20 was followed by a −4.2% average 5-day return, because in a crypto bear market deeply oversold means "the trend is down and liquidations are cascading". That is the mean-reversion-versus-momentum regime problem in one line, and it is why a single RSI threshold cannot be assumed to generalise across assets.

### 8.3 Base rates in the same data

| Measure | S&P 500 (10y) | Nasdaq-100 (41y) | Bitcoin (12y) |
|---|---|---|---|
| Mean daily return | +0.0564% | +0.0656% | +0.1882% |
| Daily standard deviation | 1.143% | 1.645% | 3.716% |
| Mean / SD | 0.049 | 0.040 | 0.051 |
| Share of up days | 54.8% | 54.5% | 51.9% |
| AR(1) coefficient | −0.147 | −0.051 | −0.089 |
| R² of AR(1) | 2.16% | 0.26% | 0.78% |
| Positive calendar years | 8 of 10 | 33 of 40 (82%) | 7 of 11 |

The AR(1) R² is the cleanest single number in this document: **between a quarter of a percent and 2.2% of the variance of tomorrow's return is explained by today's return.** Any indicator that adds even one percentage point of explanatory power on top of that is doing something remarkable — and almost nothing does.

---

## 9. Where the evidence is weakest

Listing the soft spots is more useful than another summary.

1. **Single-name technical analysis is barely studied.** Almost all of the credible positive evidence (Moskowitz et al., Hurst et al., Baltas & Kosowski) is on futures portfolios, not individual stocks. Applying portfolio-level trend evidence to a single chart is an extrapolation.
2. **RSI and MACD have thin peer-reviewed literatures.** Chong and Ng (2014) is one of very few tests, it covers five markets, finds results in two or three of them, and ignores costs. That is not a basis for confidence.
3. **Most technical-rule studies predate the modern market structure.** Brock et al. (1992) ends in 1986; Sullivan et al. (1999) in 1996. Decimalisation (2001), electronic market making, and the rise of index products changed the cost and noise structure completely.
4. **Publication bias runs in both directions.** Positive results get published; failed replications usually do not. The FDR work of Bajgrowicz and Scaillet exists precisely because the naive count of "profitable rules" is inflated.
5. **Backtests in this space are almost always in-sample parameter selection.** The Deflated Sharpe Ratio (Bailey & López de Prado) exists because a Sharpe selected from many trials is biased upward, often by more than the entire edge.
6. **Regime dependence is the rule, not the exception.** Stop-losses help in momentum regimes and hurt in mean-reverting ones (Kaminski & Lo); volatility targeting works for equities and not for bonds (Harvey et al.); RSI reversion works in equities and inverts in crypto (our §8.2). Any claim of the form "this indicator works" is incomplete without "in this regime, on this asset".
7. **The data in this app is a decade of index history.** Ten years contains one crash (2020), one inflation shock (2022), one policy shock (2025) and one war (2026). That is enough to describe, not enough to establish.

**What would change the verdicts.** A pre-registered, out-of-sample test of specific RSI and MACD parameter sets on a broad cross-section of US stocks, net of realistic costs, with a block bootstrap and a trial count. To our knowledge that study has not been published. Until it is, the honest position is the one in the summary table: trend and volatility sizing are moderate; crossovers and oscillators are weak; costs and position sizing are where the certainties live.

---

## References

**Time-series momentum and trend following**
- Moskowitz, Ooi & Pedersen (2012), *Time Series Momentum*, JFE 104(2) — [AQR](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum)
- Hurst, Ooi & Pedersen (2017), *A Century of Evidence on Trend-Following Investing*, JPM — [AQR](https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing) / [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2993026)
- Huang, Li, Wang & Zhou (2020), *Time-Series Momentum: Is It There?*, JFE 135 — [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3165284)
- Baltas & Kosowski (2020), *Demystifying Time-Series Momentum Strategies* — [DOI](https://doi.org/10.1002/9781119599364.ch3)

**Moving averages, MACD, data snooping**
- Brock, Lakonishok & LeBaron (1992), *Simple Technical Trading Rules and the Stochastic Properties of Stock Returns*, JF 47(5) — [DOI](https://doi.org/10.1111/j.1540-6261.1992.tb04681.x)
- Sullivan, Timmermann & White (1999), *Data-Snooping, Technical Trading Rule Performance, and the Bootstrap*, JF 54(5) — [DOI](https://doi.org/10.1111/0022-1082.00163)
- Bajgrowicz & Scaillet (2012), *Technical Trading Revisited*, JFE 106(3) — [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1095202)
- Lo, Mamaysky & Wang (2000), *Foundations of Technical Analysis*, JF 55(4) — [DOI](https://doi.org/10.1111/0022-1082.00265)
- Zhu & Zhou (2009), *Technical analysis: An asset allocation perspective on the use of moving averages*, JFE 92(3) — [DOI](https://doi.org/10.1016/j.jfineco.2008.07.002)
- Marshall, Cahan & Cahan (2008), *Does intraday technical analysis in the U.S. equity market have value?*, JEF 15(2) — [DOI](https://doi.org/10.1016/j.jempfin.2006.05.003)
- Chong & Ng (2014), *Revisiting the Performance of MACD and RSI Oscillators*, JRFM 7(1) — [MDPI](https://www.mdpi.com/1911-8074/7/1/1)

**RSI, mean reversion, liquidity provision**
- Wilder (1978), *New Concepts in Technical Trading Systems* — [archive.org](https://archive.org/details/newconceptsintec00wild)
- Jegadeesh (1990), *Evidence of Predictable Behavior of Security Returns*, JF 45(3) — [DOI](https://doi.org/10.1111/j.1540-6261.1990.tb05110.x)
- Lehmann (1990), *Fads, Martingales, and Market Efficiency*, QJE 105(1) — [NBER w2533](https://www.nber.org/papers/w2533)
- Nagel (2012), *Evaporating Liquidity*, RFS 25(7) — [NBER w17653](https://www.nber.org/papers/w17653)
- Avellaneda & Lee (2010), *Statistical arbitrage in the US equities market*, Quantitative Finance 10(7) — [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1153505)
- Poterba & Summers (1988), *Mean Reversion in Stock Prices*, JFE 22(1) — [NBER w2343](https://www.nber.org/papers/w2343)

**Volatility sizing and stops**
- Moreira & Muir (2017), *Volatility-Managed Portfolios*, JF 72(4) — [NBER w22208](https://www.nber.org/papers/w22208)
- Harvey, Hoyle, Korgaonkar, Rattray, Sargaison & van Hemert (2018), *The Impact of Volatility Targeting*, JPM — [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3175538)
- Cederburg, O'Doherty, Wang & Yan (2020), *On the performance of volatility-managed portfolios*, JFE 138(1) — [DOI](https://doi.org/10.1016/j.jfineco.2020.04.015)
- Kaminski & Lo (2014), *When Do Stop-Loss Rules Stop Losses?*, JFM 18 — [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=968338)

**Machine-learning methodology**
- López de Prado (2018), *Advances in Financial Machine Learning*, Wiley — [publisher](https://www.wiley.com/en-us/Advances+in+Financial+Machine+Learning-p-9781119482086)
- López de Prado (2018), *The 10 Reasons Most Machine Learning Funds Fail*, JPM 44(6) — [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3104816)
- Bailey & López de Prado (2014), *The Deflated Sharpe Ratio*, JPM 40(5) — [DOI](https://doi.org/10.3905/jpm.2014.40.5.094)

**Costs, retail performance, decay**
- Frazzini, Israel & Moskowitz (2018), *Trading Costs* — [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3229719)
- Novy-Marx & Velikov (2016), *A Taxonomy of Anomalies and Their Trading Costs*, RFS 29(1) — [DOI](https://doi.org/10.1093/rfs/hhv063)
- Barber & Odean (2000), *Trading Is Hazardous to Your Wealth*, JF 55(2) — [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=219228)
- Chague & De-Losso (2020), *Day Trading for a Living?* — [SSRN](https://doi.org/10.2139/ssrn.3423101)
- McLean & Pontiff (2016), *Does Academic Research Destroy Stock Return Predictability?*, JF 71(1) — [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2156623)
- Welch & Goyal (2008), *A Comprehensive Look at the Empirical Performance of Equity Premium Prediction*, RFS 21(4) — [DOI](https://doi.org/10.1093/rfs/hhm014)
- Kelly (1956), *A New Interpretation of Information Rate*, BSTJ 35(4) — [DOI](https://doi.org/10.1002/j.1538-7305.1956.tb03809.x)
- Thorp (2007), *The Kelly Criterion in Blackjack, Sports Betting, and the Stock Market* — [PDF](https://www.eecs.harvard.edu/cs286r/courses/fall12/papers/Thorpe_KellyCriterion2007.pdf)

**Data used in §8**
- [FRED `SP500`](https://fred.stlouisfed.org/series/SP500) · [`NASDAQ100`](https://fred.stlouisfed.org/series/NASDAQ100) · [`CBBTCUSD`](https://fred.stlouisfed.org/series/CBBTCUSD) · [`VIXCLS`](https://fred.stlouisfed.org/series/VIXCLS) — all retrieved 2026-11-15.
