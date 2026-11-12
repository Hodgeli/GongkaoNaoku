#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""题库全文检索索引（SQLite FTS5 + trigram 分词器）。

为什么用 trigram：FTS5 默认的 `unicode61` 分词器按空格/标点切词，中文整段会被当成
一个 token，搜「基尼系数」只有题干恰好等于这四个字时才命中。`trigram` 按 3 字符滑窗
建索引，等价于带索引的 `LIKE '%关键词%'`，中文效果正常。

代价是索引比原文大得多（trigram 索引约为文本的 3~4 倍），所以**只索引题干、解析、
考点、分类**四个字段，不索引 `material`：材料正文重复度高（已由 `materials.py` 去重
成独立表），且材料有单独入口，搜它的收益远不及多占的 20MB。

`content='questions'` 是外部内容表 —— 索引不重复存正文，只存倒排；因此题库被
fixups 改过之后必须 rebuild 一次，这也是它排在 `fixups` / `materials` 之后的原因。

用法：
    python search.py              # 处理 ./kaogong.db
    python search.py other.db
"""
import os
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "kaogong.db")

FTS_COLS = "stem, analysis, kadian, category"
DDL = ("CREATE VIRTUAL TABLE questions_fts USING fts5(%s, "
       "content='questions', content_rowid='id', tokenize='trigram')" % FTS_COLS)

MIN_CHARS = 3     # trigram 分词器最少 3 个字符，短于此的查询在 server 侧退回 LIKE


def build(db_path=None, quiet=False):
    """重建全文索引。幂等（每次整表重建，不做增量）。"""
    db_path = db_path or DB_PATH
    if not os.path.exists(db_path):
        if not quiet:
            print("[search] 题库不存在，跳过：%s" % db_path)
        return 0
    conn = sqlite3.connect(db_path, timeout=60)
    try:
        have = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' "
                            "AND name='questions'").fetchone()
        if not have:
            if not quiet:
                print("[search] 没有 questions 表，跳过")
            return 0
        base = os.path.getsize(db_path)
        t0 = time.time()
        # 整表重建：外部内容表不支持改列，DROP 最干净（影子表会一起删掉）
        conn.execute("DROP TABLE IF EXISTS questions_fts")
        conn.execute(DDL)
        conn.execute("INSERT INTO questions_fts(questions_fts) VALUES('rebuild')")
        conn.commit()
        n = conn.execute("SELECT COUNT(*) FROM questions_fts").fetchone()[0]
        if not quiet:
            print("[search] 全文索引已重建：%d 题，+%.1f MB，%.1fs"
                  % (n, (os.path.getsize(db_path) - base) / 1048576.0, time.time() - t0))
        return n
    finally:
        conn.close()


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else None)
