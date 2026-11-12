#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用真实复习流水反推 FSRS-5 参数（19 个 w）。

为什么需要它：`fsrs.py` 里那套 w 是 FSRS 官方在**别人**的复习数据上拟合的。
你的遗忘速度、对「一般 / 熟悉」的判定松紧、考公题型的难度分布，跟官方样本并不一样。
拿自己的 `reviews` 流水重拟合一次，同一份进度能换来更贴合你的间隔。

做法（与 fsrs-5 官方 optimizer 同思路）：
  1. 按 (user_id, qid) 把 reviews 还原成**每道题的评分序列**（时间 + 四档自评）；
  2. 用候选 w 从头重放这道题的状态机（直接调 `fsrs.grade_state`，不另写一套公式），
     在每次「间隔 ≥ 1 天」的复习前算出模型预测的记住概率 R；
  3. 用实际结果（自评 忘记 = 忘，其余 = 记住）算对数损失，坐标下降法（黄金分割）
     逐个参数压损失；
  4. 留出 20% 的题不参与拟合，用它们比较「官方默认」与「拟合参数」的真实泛化差距。

只拟合「模型层」。`MAX_REVIEW_INTERVAL=60` 的封顶、顽固题 30 天封顶、学习步这些
产品层规则不参与拟合 —— 它们不改变遗忘曲线，只改变题目什么时候再出现。

用法：
    python train_fsrs.py                  # 只看报告，不写库
    python train_fsrs.py --write          # 写进 settings.fsrs_w（重启服务生效）
    python train_fsrs.py --reset          # 删掉自定义参数，回到官方默认
    python train_fsrs.py --user u7c52...  # 只用一个账号的数据

数据量门槛：可训练事件少于 200 条时不给结论 —— 这么点数据拟合 19 个参数
必然是过拟合，不如老老实实用官方默认值。
"""
import argparse
import datetime
import json
import math
import os
import random
import sqlite3
import sys

import fsrs

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "users.db")

# 参数上下界（对齐 fsrs-optimizer v5 的 bound 表）。
# 不加上界的话，坐标下降会把 w0 推到 0.0001 —— 训练集损失更低，但模型已经没意义了。
BOUNDS = (
    (0.1, 100.0), (0.1, 100.0), (0.1, 100.0), (0.1, 100.0),   # w0-w3  S0
    (1.0, 10.0), (0.001, 4.0),                                 # w4-w5  初始难度
    (0.001, 4.0), (0.001, 0.75),                               # w6-w7  难度更新
    (0.0, 4.5), (0.0, 0.8), (0.001, 3.5),                      # w8-w10 成功增长
    (0.001, 5.0), (0.001, 0.25), (0.001, 0.9), (0.0, 4.0),     # w11-w14 遗忘衰减
    (0.0, 1.0), (1.0, 6.0),                                    # w15-w16 困难/熟悉
    (0.0, 2.0), (0.0, 2.0),                                    # w17-w18 同日
)

MIN_EVENTS = 200        # 低于此不训练
GOLDEN_ITERS = 16       # 黄金分割迭代次数（0.618^16 ≈ 1.7e-4 精度）
L2_DEFAULT = 0.15       # 朝官方默认值的正则强度（见 penalty）


# ---------- 读数据 ----------
def load_sequences(db_path, user=None):
    """reviews → [(card_key, [(datetime, grade), ...]), ...]，按时间升序。

    没有 `prev_json` 的老记录也能用：训练是从头重放，不依赖当时存的快照。
    """
    if not os.path.exists(db_path):
        return []
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    sql = "SELECT user_id, qid, grade, ts FROM reviews WHERE grade IS NOT NULL"
    args = ()
    if user:
        sql += " AND user_id=?"
        args = (user,)
    sql += " ORDER BY user_id, qid, ts, id"
    rows = conn.execute(sql, args).fetchall()
    conn.close()

    seqs, cur_key, cur = [], None, []
    for r in rows:
        try:
            dt = datetime.datetime.fromisoformat(str(r["ts"]))
        except (TypeError, ValueError):
            continue
        g = int(r["grade"])
        if g not in fsrs.RATING:
            continue
        key = (r["user_id"], r["qid"])
        if key != cur_key:
            if cur:
                seqs.append((cur_key, cur))
            cur_key, cur = key, []
        cur.append((dt, g))
    if cur:
        seqs.append((cur_key, cur))
    return seqs


def _blank_state():
    """与 srs 表一行的形状一致；grade_state 只读这些键。"""
    return dict(status="new", interval=0, repetitions=0, lapses=0, step=0,
                stability=None, difficulty=None, last_review=None, ease=2.5)


# ---------- 目标函数 ----------
def evaluate(w, seqs, collect=None):
    """返回 (对数损失总和, 可训练事件数, 命中数)。

    可训练事件 = 间隔 ≥ 1 天的复习。同一天内的重复（学习步 1 分钟 / 10 分钟）
    没有「记住了吗」的语义 —— 十分钟前刚看过，能想起来不算记忆保持。
    """
    total, n, hit = 0.0, 0, 0
    for _key, evs in seqs:
        st = _blank_state()
        for k, (dt, grade) in enumerate(evs):
            if k:
                elapsed = fsrs._elapsed_days(st.get("last_review"), dt)
                if elapsed >= 1.0:
                    p = fsrs.retrievability(elapsed, st.get("stability"))
                    y = 1.0 if fsrs.RATING.get(grade, 3) >= 2 else 0.0
                    p = min(1.0 - 1e-9, max(1e-9, p))
                    total += -(y * math.log(p) + (1.0 - y) * math.log(1.0 - p))
                    n += 1
                    hit += 1 if y else 0
                    if collect is not None:
                        collect.append((p, y))
            nxt = fsrs.grade_state(st, grade, fuzz=False, now=dt, w=w)
            nxt["last_review"] = dt.isoformat()
            st = nxt
    return total, n, hit


def logloss(w, seqs):
    total, n, _ = evaluate(w, seqs)
    return total / n if n else float("inf")


def penalty(w, lam=L2_DEFAULT):
    """朝官方默认值的 L2 正则（按各参数的定义域宽度归一化）。

    不加这一项，几千条样本拟合 19 个参数会跑飞：实测 w6（难度增量）会直接顶到
    上界 4.0、w7（难度回归）被推到 0.19 —— 训练集损失是低了一点，但生产里难度
    会在 1 和 10 之间来回摆，间隔随之崩掉。正则把「离默认值有多远」也算进目标，
    数据不够时就老老实实退回官方值。
    """
    if not lam:
        return 0.0
    s = 0.0
    for i, (lo, hi) in enumerate(BOUNDS):
        span = hi - lo
        s += ((w[i] - fsrs.DEFAULT_W[i]) / span) ** 2
    return lam * s


def objective(w, seqs, lam=L2_DEFAULT):
    """优化目标 = 对数损失 + 正则项。报告里分开列，别让正则掩盖真实拟合效果。"""
    return logloss(w, seqs) + penalty(w, lam)


# ---------- 优化 ----------
def golden_min(f, lo, hi, iters=GOLDEN_ITERS):
    """单峰假设下的黄金分割极小值。区间缩到 1e-4 就够 —— 参数再多一位小数没有意义。"""
    gr = (math.sqrt(5.0) - 1.0) / 2.0
    a, b = lo, hi
    c, d = b - gr * (b - a), a + gr * (b - a)
    fc, fd = f(c), f(d)
    for _ in range(iters):
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - gr * (b - a)
            fc = f(c)
        else:
            a, c, fc = c, d, fd
            d = a + gr * (b - a)
            fd = f(d)
    return (a + b) / 2.0


def train(seqs, w0, rounds=2, lam=L2_DEFAULT, verbose=True):
    """坐标下降：每轮按 w0..w18 顺序逐个做一维搜索。"""
    w = [float(x) for x in w0]
    cur = objective(w, seqs, lam)
    if verbose:
        print("[训练] 起点：对数损失 %.5f + 正则 %.5f = %.5f"
              % (logloss(w, seqs), penalty(w, lam), cur))
    for r in range(rounds):
        moved = 0
        for i, (lo, hi) in enumerate(BOUNDS):
            if i >= len(w):
                break

            def f(x, i=i):
                cand = w[:i] + [x] + w[i + 1:]
                return objective(cand, seqs, lam)

            x = golden_min(f, lo, hi)
            fx = f(x)
            if fx < cur - 1e-7:
                w[i] = x
                cur = fx
                moved += 1
        if verbose:
            print("[训练] 第 %d 轮：对数损失 %.5f + 正则 %.5f = %.5f（%d/%d 个参数有移动）"
                  % (r + 1, logloss(w, seqs), penalty(w, lam), cur, moved, len(w)))
        if not moved:
            break
    return w, cur


# ---------- 报告 ----------
def brier(pairs):
    return sum((p - y) ** 2 for p, y in pairs) / len(pairs) if pairs else 0.0


def calibration(pairs, buckets=5):
    """把预测概率切成几档，看「说 80% 会记住」的时候真实命中率是不是 80%。"""
    out = []
    for i in range(buckets):
        lo, hi = i / buckets, (i + 1) / buckets
        sel = [(p, y) for p, y in pairs if lo <= p < hi or (i == buckets - 1 and p >= hi)]
        if sel:
            out.append((lo, hi, len(sel), sum(p for p, _ in sel) / len(sel),
                        sum(y for _, y in sel) / len(sel)))
    return out


def report(tag, w, seqs, pairs=None):
    if pairs is None:
        pairs = []
        evaluate(w, seqs, collect=pairs)
    total, n, hit = evaluate(w, seqs)
    ll = total / n if n else 0.0
    print("%s 对数损失 %.4f · Brier %.4f · 事件 %d · 实际记住 %.1f%%"
          % (tag, ll, brier(pairs), n, 100.0 * hit / n if n else 0.0))
    return ll, n


def save_w(db_path, w):
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('fsrs_w',?)",
                 (json.dumps([round(x, 6) for x in w]),))
    conn.commit()
    conn.close()


def drop_w(db_path):
    conn = sqlite3.connect(db_path)
    conn.execute("DELETE FROM settings WHERE key='fsrs_w'")
    conn.commit()
    conn.close()


def main():
    ap = argparse.ArgumentParser(description="用真实复习流水反推 FSRS-5 参数")
    ap.add_argument("--db", default=DB_PATH, help="users.db 路径")
    ap.add_argument("--user", default=None, help="只用一个账号的数据（默认全部）")
    ap.add_argument("--write", action="store_true", help="写入 settings.fsrs_w")
    ap.add_argument("--reset", action="store_true", help="删除自定义参数，回到官方默认")
    ap.add_argument("--json", action="store_true", help="只输出参数数组，便于脚本消费")
    ap.add_argument("--max-events", type=int, default=2000,
                    help="拟合时最多用多少个事件（默认 2000，越大越慢越准）")
    ap.add_argument("--rounds", type=int, default=2, help="坐标下降轮数")
    ap.add_argument("--l2", type=float, default=L2_DEFAULT,
                    help="朝官方默认值的正则强度，0 = 关闭（默认 %.2f）" % L2_DEFAULT)
    ap.add_argument("--test-ratio", type=float, default=0.2, help="留出题比例")
    ap.add_argument("--seed", type=int, default=20261112)
    args = ap.parse_args()

    if args.reset:
        if not os.path.exists(args.db):
            print("[ERR] 找不到 %s" % args.db)
            return 1
        drop_w(args.db)
        print("[OK] 已删除 settings.fsrs_w，重启服务后回到官方默认参数。")
        return 0

    seqs = load_sequences(args.db, args.user)
    n_reviews = sum(len(e) for _, e in seqs)
    if not seqs:
        print("[!] reviews 表里没有可用的评分记录。")
        print("    先刷一批题（每道题至少复习过一次、且两次复习隔了 1 天以上），再回来训练。")
        print("    注意：同一天内的重复评分不计入训练 —— 十分钟前刚看过，能想起来不算记忆保持。")
        return 1

    # 留出集：按「题」切，不能按「事件」切 —— 同一道题的事件高度相关，按事件切会高估泛化。
    keys = [k for k, _ in seqs]
    rnd = random.Random(args.seed)
    rnd.shuffle(keys)
    n_test = int(len(keys) * args.test_ratio) if len(keys) >= 10 else 0
    test_keys = set(keys[:n_test])
    train_seqs = [s for s in seqs if s[0] not in test_keys]
    test_seqs = [s for s in seqs if s[0] in test_keys]

    full_pairs = []
    evaluate(fsrs.DEFAULT_W, seqs, collect=full_pairs)
    n_events = len(full_pairs)

    print("[数据] %d 条评分 · %d 道题 · 可训练事件 %d（间隔 ≥1 天的复习）"
          % (n_reviews, len(seqs), n_events))
    if n_events < MIN_EVENTS:
        print("[!] 可训练事件只有 %d 条，少于门槛 %d，不给结论。" % (n_events, MIN_EVENTS))
        print("    拟合 19 个参数至少要几百个「隔天复习」的样本，否则一定过拟合。")
        print("    继续用官方默认参数（间隔仍然按你的自评调整，只是曲线是别人的）。")
        return 1

    # 拟合集太大就跑不动：整卡抽样，保持每道题的序列完整
    fit_seqs = train_seqs
    if n_events > args.max_events:
        rnd.shuffle(fit_seqs)
        picked, acc = [], 0
        for s in fit_seqs:
            picked.append(s)
            acc += len(s[1])
            if acc >= args.max_events:
                break
        fit_seqs = picked
        print("[数据] 拟合抽样 %d 道题 / %d 条评分（上限 %d 事件）"
              % (len(fit_seqs), acc, args.max_events))

    print("\n--- 拟合前 ---")
    ll0_train, _ = report("[默认]", fsrs.DEFAULT_W, fit_seqs)
    if test_seqs:
        ll0_test, n_test_ev = report("[默认·留出]", fsrs.DEFAULT_W, test_seqs)

    # 先看这批数据到底有没有「区分力」：如果所有复习都发生在 90% 保持率附近，
    # 任何一组参数都能拟合同样的损失，拟合出来的数字纯属噪声。
    ps = [p for p, _ in full_pairs]
    ps.sort()
    low = sum(1 for p in ps if p < 0.7) / len(ps) * 100
    print("[分布] 预测保持率 最低 %.2f / 中位 %.2f / 最高 %.2f，其中 <70%% 的占 %.1f%%"
          % (ps[0], ps[len(ps) // 2], ps[-1], low))
    if low < 5:
        print("       ⚠ 几乎全是「高保持率」样本 —— 说明你基本都按时复习，没怎么逾期。")
        print("         这种情况下参数之间拉不开差距，拟合结果不稳定，建议继续攒数据。")

    print("\n--- 拟合中 ---")
    w, _ = train(fit_seqs, fsrs.DEFAULT_W, rounds=args.rounds, lam=args.l2)

    print("\n--- 拟合后 ---")
    ll1_train, _ = report("[拟合]", w, fit_seqs)
    if test_seqs:
        ll1_test, n_test_ev = report("[拟合·留出]", w, test_seqs)

    # 参数变化表：只看动得明显的，19 行全打太吵
    print("\n--- 参数变化（只列变化 > 5% 的）---")
    names = ("S0(忘记)", "S0(困难)", "S0(一般)", "S0(熟悉)", "D0 基准", "D0 斜率",
             "难度增量", "难度回归", "增长基数", "增长衰减", "增长曲线",
             "遗忘基数", "遗忘难度", "遗忘稳定", "遗忘曲线", "困难惩罚", "熟悉奖励",
             "同日基数", "同日偏移")
    for i, (a, b) in enumerate(zip(fsrs.DEFAULT_W, w)):
        if abs(b - a) > max(1e-9, abs(a) * 0.05):
            print("  w%-2d %-9s %8.4f → %8.4f  (%+.1f%%)"
                  % (i, names[i], a, b, (b - a) / a * 100 if a else 0.0))
    stuck = [names[i] for i, (lo, hi) in enumerate(BOUNDS)
             if abs(w[i] - lo) < 1e-3 or abs(w[i] - hi) < 1e-3]
    if stuck:
        print("  ⚠ 这些参数被推到了边界（%s）—— 数据还在「想要更极端」，"
              "说明样本不够，建议调大 --l2 或继续攒数据。" % "、".join(stuck))

    print("\n--- 校准（拟合后，全量数据）---")
    pairs = []
    evaluate(w, seqs, collect=pairs)
    for lo, hi, cnt, pred, act in calibration(pairs):
        flag = "  ← 偏乐观" if act < pred - 0.06 else ("  ← 偏保守" if act > pred + 0.06 else "")
        print("  预测 %2d-%2d%%  样本 %5d  平均预测 %5.1f%%  实际记住 %5.1f%%%s"
              % (lo * 100, hi * 100, cnt, pred * 100, act * 100, flag))

    print("\n--- 结论 ---")
    gain_train = (ll0_train - ll1_train) / ll0_train * 100 if ll0_train else 0.0
    print("  训练集：%.4f → %.4f（改善 %.1f%%）" % (ll0_train, ll1_train, gain_train))
    if test_seqs:
        gain_test = (ll0_test - ll1_test) / ll0_test * 100 if ll0_test else 0.0
        print("  留出集：%.4f → %.4f（改善 %.1f%%，%d 条事件）"
              % (ll0_test, ll1_test, gain_test, n_test_ev))
        if gain_test <= 0:
            print("  ⚠ 留出集没有改善 —— 拟合只是记住了训练集的噪声，建议继续攒数据，别急着用。")
        elif gain_test < 1.5:
            print("  改善幅度很小（<1.5%），用不用都行；官方默认参数更稳。")
        else:
            print("  ✓ 留出集也有改善，说明不是过拟合。")
    else:
        print("  （题数太少，没切留出集 —— 下面的改善数字不可信，仅供参考）")

    print("\n参数（可直接粘进 settings.fsrs_w）：")
    print(json.dumps([round(x, 6) for x in w]))

    if args.write:
        save_w(args.db, w)
        print("\n[OK] 已写入 settings.fsrs_w。**重启服务**后生效（参数在启动时载入）。")
    elif not args.json:
        print("\n未写入数据库。确认上面的留出集也有改善后，加 --write 应用：")
        print("  python train_fsrs.py --write")
    return 0


if __name__ == "__main__":
    sys.exit(main())
