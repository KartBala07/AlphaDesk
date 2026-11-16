#!/usr/bin/env python3
"""
AlphaDesk model trainer — multinomial logistic regression on triple-barrier labels.

Reads data/tmp/dataset.f32 (rows x nFeatures float32) + data/tmp/dataset.csv
(produced by tools/build-dataset.mjs, which uses the exact feature code the
browser runs), fits one softmax classifier per side, and writes
web/data/model.json.

Two things are produced:
  1. `heads`  — the deployed model, fit on every row available.
  2. `folds`  — expanding-window refits for each evaluation year. Each fold's
                weights and standardisation are stored so that the JavaScript
                evaluator can replay them exactly, giving honest out-of-sample
                numbers for data the fold never saw.

Usage: python3 tools/train.py [--iters 500] [--l2 1e-4]
"""
import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(ROOT, "data", "tmp")
OUT = os.path.join(ROOT, "web", "data", "model.json")
FEATURES = [
    "rsi14", "rsi2", "macdHist", "ema8_21", "ema21_50", "ema50_200", "close_ema200",
    "adx14", "diDiff", "atrPct", "atrRatio", "bbPctB", "bbWidth", "stochK", "stochKD",
    "volZ", "mom5", "mom20", "mom60", "mom120", "dist52wHigh", "dist52wLow",
    "rvolRatio", "obvSlope", "spyTrend", "spyRsi", "vixLevel", "vixChg5",
    "gap", "body", "isCrypto", "isEtf",
    "z_mom20", "z_mom60", "z_rsi14", "z_dist52wHigh", "z_atrPct", "z_volZ", "z_ema50_200", "z_bbPctB",
]
FOLD_YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026]


def load():
    meta_path = os.path.join(TMP, "dataset-summary.json")
    with open(meta_path) as fh:
        summary = json.load(fh)
    F = summary["features"]
    rows = summary["rows"]
    X = np.fromfile(os.path.join(TMP, "dataset.f32"), dtype=np.float32)
    if X.size != rows * F:
        raise SystemExit(f"dataset size mismatch: {X.size} != {rows * F}")
    X = X.reshape(rows, F).astype(np.float64)
    dates = np.empty(rows, dtype=object)
    syms = np.empty(rows, dtype=object)
    yl = np.empty(rows, dtype=np.int8)
    ys = np.empty(rows, dtype=np.int8)
    with open(os.path.join(TMP, "dataset.csv")) as fh:
        r = csv.DictReader(fh)
        for i, row in enumerate(r):
            dates[i] = row["date"]
            syms[i] = row["symbol"]
            yl[i] = int(row["yLong"])
            ys[i] = int(row["yShort"])
    return X, dates, syms, yl, ys, summary


def standardise(X, mask):
    mu = X[mask].mean(axis=0)
    sd = X[mask].std(axis=0)
    sd[sd < 1e-9] = 1.0
    return mu.astype(np.float32), sd


def fit(X, y, l2=1e-4, iters=500, lr=0.15, seed=7):
    """Softmax regression with Adam. Returns W (3,F), b (3,)."""
    rng = np.random.default_rng(seed)
    n, F = X.shape
    K = 3
    W = rng.normal(0, 0.01, (K, F)).astype(np.float32)
    b = np.zeros(K, dtype=np.float32)
    mW, vW = np.zeros_like(W), np.zeros_like(W)
    mb, vb = np.zeros(K, dtype=np.float32), np.zeros(K)
    b1, b2, eps = 0.9, 0.999, 1e-8
    Y = np.eye(K)[y]
    for t in range(1, iters + 1):
        Z = np.clip(X, -8, 8) @ W.T + b
        Z -= Z.max(axis=1, keepdims=True)
        E = np.exp(Z)
        P = E / E.sum(axis=1, keepdims=True)
        G = (P - Y) / n
        gW = G.T @ X + l2 * W
        gb = G.sum(axis=0)
        mW = b1 * mW + (1 - b1) * gW
        vW = b2 * vW + (1 - b2) * gW * gW
        mb = b1 * mb + (1 - b1) * gb
        vb = b2 * vb + (1 - b2) * gb * gb
        if t % 25 == 0 and not np.isfinite(gW).all():
            return None, None
        mhW = mW / (1 - b1 ** t)
        vhW = vW / (1 - b2 ** t)
        mhb = mb / (1 - b1 ** t)
        vhb = vb / (1 - b2 ** t)
        W -= lr * mhW / (np.sqrt(vhW) + eps)
        b -= lr * mhb / (np.sqrt(vhb) + eps)
    return W, b


def log_loss(X, y, mu, sd, W, b):
    Z = np.clip((X - mu) / sd, -8, 8) @ W.T + b
    Z -= Z.max(axis=1, keepdims=True)
    E = np.exp(Z)
    P = E / E.sum(axis=1, keepdims=True)
    return float(-np.log(np.maximum(P[np.arange(len(y)), y], 1e-12)).mean()), P


def round_list(a, d=6):
    return [round(float(x), d) for x in np.ravel(a)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iters", type=int, default=600)
    ap.add_argument("--l2", type=float, default=1e-4)
    ap.add_argument("--lr", type=float, default=0.08)
    args = ap.parse_args()

    X, dates, syms, yl, ys, summary = load()
    n, F = X.shape
    print(f"loaded {n} rows x {F} features, {dates[0]} .. {dates[-1]}")

    years = np.array([d[:4] for d in dates])

    # ---- walk-forward folds -------------------------------------------------
    folds = []
    for Y in FOLD_YEARS:
        train_mask = years < str(Y)
        eval_mask = years == str(Y)
        if train_mask.sum() < 5000 or eval_mask.sum() < 500:
            print(f"  fold {Y}: skipped (train={train_mask.sum()}, eval={eval_mask.sum()})")
            continue
        mu, sd = standardise(X, train_mask)
        Xtr, Xev = (X[train_mask] - mu) / sd, (X[eval_mask] - mu) / sd
        head = {}
        for side, y in (("long", yl), ("short", ys)):
            W, b = fit(Xtr, y[train_mask], l2=args.l2, iters=args.iters, lr=args.lr)
            tries = 0
            while W is None and tries < 3:
                tries += 1
                print(f"    diverged on {side} fold {Y}; retry with lr/{4 ** tries}")
                W, b = fit(Xtr, y[train_mask], l2=args.l2, iters=args.iters, lr=args.lr / (4 ** tries))
            ll, Pev = log_loss(X[eval_mask], y[eval_mask], mu, sd, W, b)
            head[side] = {"W": [round_list(r) for r in W], "b": round_list(b), "evalLogLoss": round(ll, 5)}
        folds.append({
            "year": Y, "trainRows": int(train_mask.sum()), "evalRows": int(eval_mask.sum()),
            "mean": round_list(mu), "std": round_list(sd), "heads": head,
        })
        print(f"  fold {Y}: train={train_mask.sum():>6} eval={eval_mask.sum():>5} "
              f"ll_long={head['long']['evalLogLoss']:.4f} ll_short={head['short']['evalLogLoss']:.4f}")

    # ---- deployed model -----------------------------------------------------
    mu, sd = standardise(X, np.ones(n, dtype=bool))
    Xs = (X - mu) / sd
    deployed = {}
    importance = {}
    for side, y in (("long", yl), ("short", ys)):
        W, b = fit(Xs, y, l2=args.l2, iters=args.iters, lr=args.lr)
        tries = 0
        while W is None and tries < 3:
            tries += 1
            W, b = fit(Xs, y, l2=args.l2, iters=args.iters, lr=args.lr / (4 ** tries))
        ll, _ = log_loss(X, y, mu, sd, W, b)
        deployed[side] = {"W": [round_list(r) for r in W], "b": round_list(b), "trainLogLoss": round(ll, 5)}
        imp = np.abs(W).mean(axis=0)
        importance[side] = sorted(
            [{"feature": FEATURES[i], "weight": round(float(imp[i]), 5)} for i in range(F)],
            key=lambda d: -d["weight"])[:12]
        print(f"deployed {side}: train logloss={ll:.4f}")

    # class distribution + base rates
    base = {
        "longWin": float((yl == 0).mean()), "longLoss": float((yl == 1).mean()), "longTimeout": float((yl == 2).mean()),
        "shortWin": float((ys == 0).mean()), "shortLoss": float((ys == 1).mean()), "shortTimeout": float((ys == 2).mean()),
    }

    model = {
        "version": "1.0.0",
        "engineVersion": "1.0.0",
        "trainedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "algorithm": "multinomial logistic regression (softmax, Adam, L2)",
        "objective": "probability that a +2.0 ATR take-profit is touched before a -1.0 ATR stop within 15 trading days",
        "tpMult": 2.0, "slMult": 1.0, "horizon": 15,
        "features": FEATURES,
        "mean": round_list(mu), "std": round_list(sd),
        "heads": deployed,
        "folds": folds,
        "baseRates": base,
        "importance": importance,
        "training": {
            "rows": int(n), "features": F, "dateRange": [str(dates[0]), str(dates[-1])],
            "symbols": int(len(set(syms))), "l2": args.l2, "iters": args.iters, "lr": args.lr,
            "droppedNaNRows": int(summary["rows"]) - int(n),
        },
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(model, fh, separators=(",", ":"))
    size = os.path.getsize(OUT)
    print(f"\nwrote {OUT} ({size/1024:.1f} KB)")
    print("base rates:", {k: round(v, 4) for k, v in base.items()})
    print("top long features:", ", ".join(f"{d['feature']}" for d in importance['long'][:6]))


if __name__ == "__main__":
    main()
