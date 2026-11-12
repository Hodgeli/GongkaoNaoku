#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FSRS-5 间隔重复引擎（v1.7.0 起替代 SM-2）

为什么换：SM-2 只有一个难度系数 ease，把「记住了」和「忘了」都折算成同一个乘法因子，
对「同一天学一大批同质题」的考公场景不准 —— 同一道题第 5 次复习和第 50 次复习用的是
同一套倍率。FSRS 把记忆拆成**稳定性 S（记住多久）**和**难度 D（这题对你多难）**两个变量，
用「当前可提取概率 R」决定下一次间隔，长尾表现明显更好。

与学习步的关系（重要）：
FSRS 本身没有 Anki 的 learning steps，它用 short-term 公式处理同一天内的重复。
我们**保留** 1 分钟 / 10 分钟两档学习步 —— 「忘记」后要能几分钟内真的再见到，
这是刷题直觉，也是 FSRS 长期间隔模型不该管的范围。分工是：
  · 学习阶段：学习步决定什么时候再出现，S 用 short-term 公式（w17/w18）微调；
  · 复习阶段：完全由 FSRS 计算间隔（R→S'→interval）。
这正是 Anki 官方支持 FSRS 后的形态。

四档自评到 FSRS rating 的映射（**不能直接用 1/3/4/5**，FSRS 的 3 是 Good 不是 Hard）：
  忘记(1) → Again(1) ｜ 困难(3) → Hard(2) ｜ 一般(4) → Good(3) ｜ 熟悉(5) → Easy(4)
"""
import datetime
import json
import math
import random

# ---------- 常量 ----------
RATING = {1: 1, 3: 2, 4: 3, 5: 4}      # 自评 → FSRS rating（1..4）

# FSRS-5 官方默认参数（19 个）。可用 settings.fsrs_w（JSON 数组）覆盖。
DEFAULT_W = (
    0.40255, 1.18385, 3.173, 15.69105,   # w0-w3  S0(Again/Hard/Good/Easy)
    7.1949, 0.5345,                       # w4-w5  初始难度 D0
    1.4604, 0.0046,                       # w6-w7  难度更新与均值回归
    1.54575, 0.1192, 1.01925,             # w8-w10 成功时的稳定性增长
    1.9395, 0.11, 0.29605, 2.2698,        # w11-w14 遗忘时的稳定性衰减
    0.2315, 2.9898,                       # w15-w16 困难惩罚 / 熟悉奖励
    0.51655, 0.6621,                      # w17-w18 同日（短期）稳定性
)

DECAY = -0.5
FACTOR = 19.0 / 81.0                    # 使 R(S, S) = 0.9
REQUEST_RETENTION = 0.9                 # 目标记忆保持率
MAX_INTERVAL = 365 * 5                  # 模型层间隔上限（天）

# 产品层间隔上限。FSRS 在「全熟悉」时会把间隔推到几百天（模型假设你诚实评估、
# 且目标是终身保留）；考公是几个月的冲刺周期，几百天后再见等于没复习。
# 所以普通题最多 60 天一轮，顽固题 30 天一轮。
MAX_REVIEW_INTERVAL = 60

# ---------- 学习步（保留 Anki 式两档） ----------
STEPS = (1, 10)          # 分钟
GRADUATE_DAYS = 1        # 「一般」走完学习步后的毕业间隔
EASY_DAYS = 4            # 「熟悉」跳过剩余学习步直接毕业

# ---------- 抖动 ----------
FUZZ_MIN_DAYS = 3
FUZZ_RATIO = 0.05

# ---------- 顽固题 ----------
LEECH_AT = 8             # lapses ≥ 8 视为顽固题
LEECH_CAP = 30           # 顽固题间隔封顶（天）

_PARAMS = None


def set_params(seq):
    """从 settings 载入自定义参数（至少 19 个浮点）。失败返回 False，保持默认。"""
    global _PARAMS
    try:
        v = tuple(float(x) for x in seq)
    except (TypeError, ValueError):
        return False
    if len(v) < 19:
        return False
    _PARAMS = v
    return True


def params():
    return _PARAMS or DEFAULT_W


# ---------- 基础工具 ----------
def add_days(days):
    return (datetime.date.today() + datetime.timedelta(days=int(days))).isoformat()


def _soon(minutes):
    """N 分钟后到期（同一天内的学习步）。"""
    t = datetime.datetime.now() + datetime.timedelta(minutes=minutes)
    return t.isoformat(timespec="seconds")


def _due_date(days, now):
    return (now.date() + datetime.timedelta(days=int(days))).isoformat()


def _due_soon(minutes, now):
    return (now + datetime.timedelta(minutes=minutes)).isoformat(timespec="seconds")


def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


def _elapsed_days(last_review, now):
    """距上次复习过了多少天（浮点）。无记录或解析失败按 0 处理。"""
    if not last_review:
        return 0.0
    try:
        t = datetime.datetime.fromisoformat(str(last_review))
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, (now - t).total_seconds() / 86400.0)


# ---------- FSRS 核心公式 ----------
def retrievability(elapsed_days, s):
    """当前可提取概率 R。elapsed=0 时为 1.0。"""
    if s is None or s <= 0:
        return 0.0
    return (1 + FACTOR * max(0.0, elapsed_days) / s) ** DECAY


def _d0(w, rating):
    return _clamp(w[4] - (rating - 3) * w[5], 1.0, 10.0)


def _next_difficulty(w, d, rating):
    delta = -w[6] * (rating - 3)
    nd = d + delta * (10.0 - d) / 9.0
    # 均值回归：避免难度被单次评分推得太远
    return _clamp(w[7] * w[4] + (1 - w[7]) * nd, 1.0, 10.0)


def _recall_stability(w, d, s, r, rating):
    """记住了：稳定性增长。困难打折、熟悉加成。"""
    hard = w[15] if rating == 2 else 1.0
    easy = w[16] if rating == 4 else 1.0
    return s * (1 + math.exp(w[8]) * (11 - d) * (s ** -w[9]) *
                (math.exp((1 - r) * w[10]) - 1) * hard * easy)


def _forget_stability(w, d, s, r):
    """忘记了：稳定性重算，且不超过原值（遗忘不该让间隔变长）。"""
    ns = w[11] * (d ** -w[12]) * ((s + 1) ** w[13] - 1) * math.exp((1 - r) * w[14])
    return min(s, ns)


def _short_term_stability(w, s, rating):
    """同日（学习步内）的稳定性微调。"""
    return s * math.exp(w[17] * (rating - 3 + w[18]))


def next_interval(s):
    """由稳定性反解间隔天数（默认 retention 0.9 时恰好等于 round(s)）。"""
    iv = s / FACTOR * (REQUEST_RETENTION ** (1 / DECAY) - 1)
    return int(_clamp(round(iv), 1, MAX_INTERVAL))


def _fuzz(days, floor):
    """长间隔 ±5%（至少 ±1 天），保证仍严格大于 floor。
    不加抖动的话，同一天学的题会拿到相同间隔、永远同一天集体到期。"""
    if days < FUZZ_MIN_DAYS:
        return days
    span = max(1, round(days * FUZZ_RATIO))
    return max(floor + 1, days + random.randint(-span, span))


# ---------- 主入口 ----------
def grade_state(state, grade, fuzz=True, now=None):
    """state: dict(status, interval, repetitions, lapses, step, stability, difficulty, last_review)
    grade in {1,3,4,5}。返回新 dict（含 due / interval / stability / difficulty / step）。

    due 有两种格式：学习步内为 'YYYY-MM-DDTHH:MM:SS'，长间隔为 'YYYY-MM-DD'。
    两种格式在 SQL 里靠字符串比较天然兼容（'2026-11-12' <= '2026-11-12T15:30:00'），
    所以老数据不需要迁移。
    """
    w = params()
    grade = int(grade)
    rt = RATING.get(grade, 3)
    now = now or datetime.datetime.now()

    S = state.get("stability")
    D = state.get("difficulty")
    interval = int(state.get("interval") or 0)
    reps = int(state.get("repetitions") or 0)
    lapses = int(state.get("lapses") or 0)
    status = state.get("status") or "new"
    step = max(0, min(int(state.get("step") or 0), len(STEPS) - 1))
    ease = float(state.get("ease") or 2.5)     # 仅保留历史值，FSRS 不再使用

    # 初始化 S/D：
    #   · 新卡 → S0(rating) / D0(rating)
    #   · 老卡（SM-2 时代留下的 interval>0）→ 按「间隔即稳定性」反推，
    #     否则一张复习了 10 次、间隔 60 天的卡会被打回 3 天，等于白学
    if S is None or float(S) <= 0:
        if interval > 0 and status != "new":
            S = float(interval)
        else:
            S = float(w[rt - 1])
        D = _d0(w, rt)
    else:
        S = float(S)
        D = float(D) if D else _d0(w, rt)
        D = _clamp(D, 1.0, 10.0)

    elapsed = _elapsed_days(state.get("last_review"), now)
    R = retrievability(elapsed, S) if elapsed > 0 else 1.0

    if rt == 1:
        # 忘记：回到第一个学习步（1 分钟后再见）。
        if status == "review" and interval > 0:
            lapses += 1
            S = _forget_stability(w, D, S, R)      # 长间隔后遗忘：稳定性大幅下降
        elif status == "learning":
            S = _short_term_stability(w, S, rt)    # 学习步内又忘：小幅下降
        else:
            S = float(w[0])                        # 首次就没印象 = S0(Again)
        D = _next_difficulty(w, D, rt)
        reps, step, interval = 0, 0, 0
        status = "learning"
        due = _due_soon(STEPS[0], now)
    elif status in ("new", "learning"):
        # 学习阶段：由学习步决定下次出现时间，S 只做短期微调
        if status == "learning":
            S = _short_term_stability(w, S, rt)
        D = _next_difficulty(w, D, rt)
        if rt == 4:
            # 熟悉 → 跳过剩余学习步，直接毕业
            reps, step, interval = 1, 0, EASY_DAYS
            status = "review"
            S = float(interval)      # 校准：S 的语义是「间隔」，毕业 4 天就该 S=4
            due = _due_date(interval, now)
        elif rt == 2:
            # 困难 → 停在本步重来（1 分钟档还是 1 分钟，10 分钟档还是 10 分钟）
            status = "learning"
            due = _due_soon(STEPS[step], now)
        else:
            # 一般 → 前进一步；走完最后一步即毕业
            step += 1
            if step >= len(STEPS):
                reps, step, interval = 1, 0, GRADUATE_DAYS
                status = "review"
                S = float(interval)  # 同上校准，否则 S0(Good)=3.17 会让第一次复习直接跳到几十天
                due = _due_date(interval, now)
            else:
                status = "learning"
                due = _due_soon(STEPS[step], now)
    else:
        # 复习阶段：完全交给 FSRS
        reps += 1
        old = interval
        S = _recall_stability(w, D, S, R, rt)
        D = _next_difficulty(w, D, rt)
        base = max(old + 1, next_interval(S))      # 间隔必须严格递增
        base = min(base, MAX_REVIEW_INTERVAL)      # 但不能靠 old+1 突破上限
        interval = _fuzz(base, old) if fuzz else base
        if lapses >= LEECH_AT:
            interval = min(interval, LEECH_CAP)    # 顽固题封顶，逼它反复短间隔见面
        interval = min(interval, MAX_REVIEW_INTERVAL)
        status = "review"
        due = _due_date(interval, now)

    return dict(ease=round(ease, 3), interval=interval, repetitions=reps,
                lapses=lapses, status=status, due=due, step=step,
                stability=round(float(S), 4), difficulty=round(float(D), 4))


def is_leech(lapses):
    return int(lapses or 0) >= LEECH_AT


# 掌握度分桶（用于总览统计），基于 interval
def mastery_bucket(interval):
    if interval <= 0:
        return "学习中"
    if interval < 7:
        return "初记"
    if interval < 21:
        return "短期"
    if interval < 60:
        return "长期"
    return "稳固"


def dump_params():
    return json.dumps(list(params()))
