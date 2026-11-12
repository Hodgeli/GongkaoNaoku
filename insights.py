#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统计页的三个「深度」视图：遗忘曲线、目标达成日历、考点正确率时间序列。

都只读 reviews / srs，不改任何数据。SQL 集中在这里，server.py 只负责鉴权与返回。
"""
import datetime
import json

import fsrs

# 遗忘曲线的天数分桶。1~2 天、2~3 天这种细粒度放在前面 —— 学习步刚毕业那几档
# 遗忘最快，也是「刚背完就忘」最容易被感知到的地方。
FORGET_BUCKETS = ((1, 2), (2, 3), (3, 5), (5, 8), (8, 13), (13, 21),
                  (21, 34), (34, 55), (55, 90), (90, 10 ** 6))


def forgetting(q_all, uid, days=730):
    """实测遗忘曲线 vs 模型预测。

    每个样本 = 一次「间隔 ≥1 天」的复习：用复习前的稳定性 S 与间隔 t 算出模型
    认为的记住概率，再对照实际结果（自评不是「忘记」就算记住）。
    S 优先取 `prev_json` 里记着的 stability；老数据没有快照，就退回
    `interval_before` —— 那正是上次给出的间隔，与 S 在数值上等价（默认保持率下
    next_interval(S) ≈ S）。
    """
    since = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    rows = q_all("""SELECT qid, ts, grade, interval_before, prev_json
                    FROM reviews WHERE user_id=? AND grade IS NOT NULL AND ts>=?
                    ORDER BY qid, ts""", (uid, since))
    out = [dict(lo=lo, hi=hi, n=0, ok=0, pred=0.0) for lo, hi in FORGET_BUCKETS]
    prev_ts, prev_s = {}, {}
    for r in rows:
        qid = r["qid"]
        try:
            ts = datetime.datetime.fromisoformat(str(r["ts"]))
        except (TypeError, ValueError):
            continue
        last = prev_ts.get(qid)
        prev_ts[qid] = ts
        if last is None:
            continue
        elapsed = (ts - last).total_seconds() / 86400.0
        if elapsed < 1.0:
            continue                      # 同一天内的重复没有「记住多久」的含义
        s = prev_s.get(qid)
        if not s:
            # prev_json 里存的是「这次评分之前」的状态
            try:
                snap = json.loads(r["prev_json"] or "{}")
                s = float(snap.get("stability") or 0)
            except (TypeError, ValueError):
                s = 0.0
        if not s or s <= 0:
            s = float(r["interval_before"] or 0)
        if not s or s <= 0:
            prev_s[qid] = 0.0
            continue
        pred = fsrs.retrievability(elapsed, s)
        ok = 1 if int(r["grade"]) != 1 else 0
        for b in out:
            if b["lo"] <= elapsed < b["hi"]:
                b["n"] += 1
                b["ok"] += ok
                b["pred"] += pred
                break
        prev_s[qid] = s
    for b in out:
        if b["n"]:
            b["recall"] = round(b["ok"] / b["n"] * 100, 1)
            b["pred"] = round(b["pred"] / b["n"] * 100, 1)
        else:
            b["recall"] = None
            b["pred"] = None
        b.pop("ok", None)
        if b["hi"] >= 10 ** 6:
            b["hi"] = None               # 前端显示成「90 天以上」
    return {"buckets": [b for b in out if b["n"]] or [],
            "total": sum(b["n"] for b in out)}


def calendar(q_all, uid, days=91):
    """每日目标达成日历（近 13 周）。

    只记了「当前目标」，没有目标的历史版本 —— 所以这里一律用今天的目标去比，
    老日子可能因此显得偏严或偏松。UI 上会注明这一点。
    """
    today = datetime.date.today()
    start = today - datetime.timedelta(days=days - 1)
    rows = q_all("""SELECT substr(ts,1,10) d, COUNT(DISTINCT qid) n
                    FROM reviews WHERE user_id=? AND substr(ts,1,10)>=?
                    GROUP BY d""", (uid, start.isoformat()))
    got = {r["d"]: r["n"] for r in rows}
    out = []
    d = start
    while d <= today:
        k = d.isoformat()
        out.append({"d": k, "n": got.get(k, 0)})
        d += datetime.timedelta(days=1)
    return {"days": out, "start": start.isoformat(), "end": today.isoformat()}


def kadian_trend(q_all, uid, weeks=12, top=6, days=180):
    """考点正确率的时间序列：按周聚合，取题量最大的几个考点。

    只给「每周至少 1 次」的格子，空缺就是那周没练 —— 不要用 0 补，
    0% 和「没做」在图上完全是两回事。
    """
    since = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    rows = q_all("""SELECT q.kadian kd, q.module m, substr(r.ts,1,10) d,
                           COUNT(*) n,
                           SUM(CASE WHEN COALESCE(r.is_correct,
                                    CASE WHEN r.grade<>1 THEN 1 ELSE 0 END)=1
                               THEN 1 ELSE 0 END) ok
                    FROM reviews r JOIN qdb.questions q ON q.qid=r.qid
                    WHERE r.user_id=? AND r.ts>=? AND IFNULL(q.kadian,'')<>''
                    GROUP BY q.kadian, d""", (uid, since))
    if not rows:
        return {"weeks": [], "series": []}

    def wk(day):
        d = datetime.date.fromisoformat(day)
        mon = d - datetime.timedelta(days=d.weekday())
        return mon.isoformat()

    # 周轴：从最早的一周到本周，连续的周都要有，否则横轴会跳
    all_weeks = sorted({wk(r["d"]) for r in rows})
    first = datetime.date.fromisoformat(all_weeks[0])
    this_mon = datetime.date.today() - datetime.timedelta(days=datetime.date.today().weekday())
    axis, d = [], first
    while d <= this_mon:
        axis.append(d.isoformat())
        d += datetime.timedelta(days=7)
    if len(axis) > weeks:
        axis = axis[-weeks:]
    keep = set(axis)

    agg = {}
    for r in rows:
        w = wk(r["d"])
        if w not in keep:
            continue
        a = agg.setdefault(r["kd"], {"kadian": r["kd"], "module": r["m"],
                                     "n": 0, "ok": 0, "pts": {}})
        a["n"] += r["n"]
        a["ok"] += r["ok"]
        p = a["pts"].setdefault(w, [0, 0])
        p[0] += r["n"]
        p[1] += r["ok"]

    series = sorted(agg.values(), key=lambda x: -x["n"])[:top]
    for a in series:
        a["acc"] = round(a["ok"] / a["n"] * 100, 1) if a["n"] else 0
        a["points"] = [{"w": w,
                        "acc": round(a["pts"][w][1] / a["pts"][w][0] * 100, 1),
                        "n": a["pts"][w][0]} for w in axis if w in a["pts"]]
        a.pop("pts")
        a.pop("ok")
    return {"weeks": axis, "series": series}
