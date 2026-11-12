#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SM-2 间隔重复引擎（Anki 风格）。四档评分：忘记(1)/困难(3)/一般(4)/熟悉(5)

v1.6.0 起引入「学习步」与「间隔抖动」：

1. 学习步（learning steps）
   以前「忘记」直接把 interval 打成 0、due 记成今天，结果是被随机抽到才再见一次，
   运气不好整组刷完都碰不到；而「1 天后」的题又要等到明天零点才回来。
   现在新题 / 遗忘题先走 1 分钟 → 10 分钟两个学习步，走完才毕业成 1 天间隔。
   学习步的到期时间带时分秒，长间隔仍然只记日期（当天任意时刻都算到期）。

2. 间隔抖动（fuzz）
   同一天学的题会拿到完全相同的间隔，于是永远在同一天一起到期 —— 学 100 道新题，
   6 天后就一次性涌来 100 道复习。长间隔按 ±5% 抖动（至少 ±1 天）把波峰摊平。

3. 「困难」的增长倍率修正
   原实现是 interval*ease*1.2（约 3 倍），比「一般」的 interval*ease（2.5 倍）还快，
   等于「记得很吃力」反而奖励了更长的间隔。现在按 Anki 口径：
   困难 = ×1.2、一般 = ×ease、熟悉 = ×ease×1.3，并保证间隔严格递增。

due 的两种格式（纯日期 / 日期+时间）在 SQL 里靠字符串比较天然兼容：
'2025-11-12' <= '2025-11-12T15:30:00' 成立，所以老数据不需要迁移。
"""
import datetime
import random

STEPS = (1, 10)        # 学习步（分钟）：新题 / 遗忘题先按这两档在当天内反复出现
GRADUATE_DAYS = 1      # 走完学习步后的毕业间隔（天）
EASY_DAYS = 4          # 自评「熟悉」时跳过剩余学习步，直接给的间隔（天）
FUZZ_MIN_DAYS = 3      # 间隔 ≥3 天才抖动：短间隔抖了只会打乱节奏
FUZZ_RATIO = 0.05      # 抖动幅度 ±5%


def add_days(days):
    return (datetime.date.today() + datetime.timedelta(days=days)).isoformat()


def _soon(minutes):
    """N 分钟后到期（同一天内的学习步）。"""
    t = datetime.datetime.now() + datetime.timedelta(minutes=minutes)
    return t.isoformat(timespec="seconds")


def _fuzz(days, floor):
    """给长间隔加 ±5% 抖动，避免同一天学的题永远同一天到期（雪崩式波峰）。
    抖动后仍保证严格大于 floor（原间隔），否则「复习」反而把间隔缩短了。"""
    if days < FUZZ_MIN_DAYS:
        return days
    span = max(1, round(days * FUZZ_RATIO))
    return max(floor + 1, days + random.randint(-span, span))


def grade_state(state, grade, fuzz=True):
    """state: dict(ease,interval,repetitions,lapses,status,step). grade in {1,3,4,5}.
    返回新的 dict 含 due（可能是 'YYYY-MM-DD' 或 'YYYY-MM-DDTHH:MM:SS'）。
    interval 单位=天；step 为当前学习步下标，0 表示在第一步。"""
    ease = float(state.get("ease") or 2.5)
    interval = int(state.get("interval") or 0)
    reps = int(state.get("repetitions") or 0)
    lapses = int(state.get("lapses") or 0)
    status = state.get("status") or "new"
    step = max(0, min(int(state.get("step") or 0), len(STEPS) - 1))   # 防脏数据越界
    grade = int(grade)

    if grade < 3:
        # 忘记：回到第一个学习步（1 分钟后再见）。复习阶段遗忘记一次 lapse。
        if status == "review":
            lapses += 1
        reps, step, interval = 0, 0, 0
        status = "learning"
        ease = max(1.3, ease - 0.2)      # 遗忘要付出 ease 代价，否则间隔照样飞涨
        due = _soon(STEPS[0])
    elif status in ("new", "learning"):
        # 学习阶段：按步推进，走完最后一步即毕业
        if grade == 5:
            # 熟悉 → 跳过剩余学习步，直接毕业；给一个比普通毕业更长的间隔
            reps, step, interval = 1, 0, EASY_DAYS
            status = "review"
            ease = min(3.0, ease + 0.15)
            due = add_days(interval)
        elif grade == 3:
            # 困难 → 停在本步重来（1 分钟档还是 1 分钟、10 分钟档还是 10 分钟）。
            # 「勉强想起来」不该被推着往前走，也不该退回到第一步。
            status = "learning"      # 必须置 learning：留 'new' 会让它既算新题、又不进到期复习池
            due = _soon(STEPS[step])
        else:
            # 一般（或第一步就选困难）→ 前进一步
            step += 1
            if step >= len(STEPS):
                reps, step, interval = 1, 0, GRADUATE_DAYS
                status = "review"
                due = add_days(interval)
            else:
                status = "learning"  # 同上：停在 10 分钟档的题必须离开 new
                due = _soon(STEPS[step])
    else:
        # 复习阶段：SM-2 标准间隔
        reps += 1
        old = interval
        if reps == 2:
            # 毕业后的第二次复习：至少 6 天，但「熟悉毕业」的题不该被拉回到 6 天
            base = max(6, round(old * ease))
        elif grade == 3:
            base = round(old * 1.2)                  # 困难：只涨 20%
        elif grade == 4:
            base = round(old * ease)                 # 一般：按 ease 增长
        else:
            base = round(old * ease * 1.3)           # 熟悉：额外奖励 30%
        base = max(old + 1, base)                    # 间隔必须严格递增
        interval = _fuzz(base, old) if fuzz else base
        ease = ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02))
        if ease < 1.3:
            ease = 1.3
        status = "review"
        due = add_days(interval)

    return dict(ease=round(ease, 3), interval=interval, repetitions=reps,
                lapses=lapses, status=status, due=due, step=step)


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
