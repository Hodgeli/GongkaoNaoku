#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""题库数据修正补丁的应用器。

为什么需要它：`kaogong.db` 是构建产物（由 `kaogong.db.part-*` 合并而成），
不进版本库。因此逐题的数据修正不能直接改库，只能以 `data/fixups.json`
的形式随仓库分发，在「合并分卷之后」或「parse.py 导入之后」自动套用一次。

补丁按 `qid` 定位、只更新列出的列、可重复执行（幂等）。
"""
import os
import json
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
FIXUPS = os.path.join(HERE, "data", "fixups.json")

# 白名单：只允许补丁改这些列，避免误改 qid / 统计列
ALLOWED = {"material", "material_ref", "img_refs", "has_image",
           "options", "answer", "qtype", "stem", "analysis"}


def apply(db_path=None):
    """把 data/fixups.json 套到指定题库上，返回实际更新的行数（0 表示没补丁或已是最新）。"""
    db_path = db_path or os.path.join(HERE, "kaogong.db")
    if not os.path.exists(FIXUPS) or not os.path.exists(db_path):
        return 0
    try:
        with open(FIXUPS, encoding="utf-8") as f:
            doc = json.load(f)
    except Exception as e:
        print("[fixups] 读取补丁失败，跳过：%s" % e)
        return 0
    rows = doc.get("rows") or []
    if not rows:
        return 0
    conn = sqlite3.connect(db_path)
    n = 0
    try:
        for item in rows:
            qid = str(item.get("qid") or "").strip()
            cols = [k for k in item if k != "qid" and k in ALLOWED]
            if not qid or not cols:
                continue
            sets = ", ".join("%s=?" % c for c in cols)
            cur = conn.execute("UPDATE questions SET %s WHERE qid=?" % sets,
                               [item[c] for c in cols] + [qid])
            n += cur.rowcount
        conn.commit()
    finally:
        conn.close()
    return n


if __name__ == "__main__":
    print("已应用 %d 行修正（data/fixups.json）" % apply())
