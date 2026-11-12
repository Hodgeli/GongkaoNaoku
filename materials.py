#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""材料独立成表（子目录级材料）。

为什么需要它：源题库把材料放在 `15-材料/` 目录，每道题引用其中一份。`parse.py`
导入时把材料正文**复制**进每一道题的 `questions.material`，于是同一段材料在库里
存了 N 份 —— 实测 7,340 道有材料的题只对应 1,209 段不同文本，重复文本合计约
4.5 MB。

代价不只是空间。分组只能靠 `material_ref`（「编号 + 材料首句」），而这个编号是
各份试卷自己编的：同一段材料在不同卷子里编号不同就会被拆成几组，不同材料撞上
同一个编号又会被并成一组 —— 材料组题页「湖北 2019 案例分析 60 题一组」就是这么
来的。

这个脚本把材料还原成一张 `materials` 表，`questions.material_id` 多对一关联。
mid 取材料正文的 sha1，内容不变则 mid 不变，重建题库、重复执行都稳定。

关于库里原有的 `materials` 表：那是上游早期版本的遗留（建了表、灌了 1,578 行，
但 `questions` 从来没有引用过它，且只覆盖 800 段材料）。这里**以
`questions.material` 为准重建**，同时把它记着的 `title` / `path` 按正文匹配回来，
不丢来源信息。

用法：
    python materials.py              # 处理 ./kaogong.db
    python materials.py other.db
作为构建步骤，`assemble_db.py` 与 `parse.py` 会在打完 fixups 补丁后自动调用它。
"""
import hashlib
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "kaogong.db")

IMG_SRC = re.compile(r'<img[^>]+src="([^"]+)"', re.I)
TAG = re.compile(r"<[^>]+>")
REF_NUM = re.compile(r"^\d+\s+")

# 与 parse.py 的建表保持一致（空库也要能跑）
DDL = """
CREATE TABLE IF NOT EXISTS materials(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mid TEXT UNIQUE, title TEXT, body TEXT, path TEXT
);
"""

EXTRA_COLS = ("ALTER TABLE materials ADD COLUMN img_refs TEXT",
              "ALTER TABLE materials ADD COLUMN has_image INTEGER DEFAULT 0",
              "ALTER TABLE materials ADD COLUMN n_q INTEGER DEFAULT 0",
              "ALTER TABLE materials ADD COLUMN n_paper INTEGER DEFAULT 0")


def fingerprint(body):
    """材料指纹：正文内容哈希。同一段材料在不同试卷里 mid 相同。"""
    return "M" + hashlib.sha1(body.encode("utf-8")).hexdigest()[:14]


def _snippet(body, n=60):
    s = re.sub(r"\s+", " ", TAG.sub(" ", body or "")).strip()
    return s[:n]


def _ref_label(ref, body):
    """「3680726 2021年全国及东、中、西部县域农业…」→ 去掉题号前缀，只留可读部分。"""
    s = REF_NUM.sub("", (ref or "").strip()).strip()
    return s[:60] or _snippet(body, 40)


def build(db_path=None, quiet=False):
    """把 questions.material 归并成 materials 表并回填 material_id。幂等。"""
    db_path = db_path or DB_PATH
    if not os.path.exists(db_path):
        if not quiet:
            print("[materials] 题库不存在，跳过：%s" % db_path)
        return 0
    conn = sqlite3.connect(db_path, timeout=60)
    try:
        conn.executescript(DDL)
        for ddl in EXTRA_COLS:
            try:
                conn.execute(ddl)
            except sqlite3.OperationalError:
                pass          # 已存在
        # 分卷是旧结构，合并出来没有 material_id
        try:
            conn.execute("ALTER TABLE questions ADD COLUMN material_id TEXT")
        except sqlite3.OperationalError:
            pass
        conn.commit()

        rows = conn.execute("""SELECT id, material, IFNULL(material_ref,'') ref,
                                      IFNULL(region,'') region, IFNULL(year,'') year,
                                      IFNULL(paper,'') paper
                               FROM questions
                               WHERE material IS NOT NULL AND material<>''""").fetchall()
        if not rows:
            if not quiet:
                print("[materials] 没有带材料的题，跳过")
            return 0

        # 老 materials 表里的 title / path 按正文匹配回来（那 800 段有可读的「试卷名 材料N」）
        meta = {}
        for body, title, path in conn.execute(
                "SELECT body, IFNULL(title,''), IFNULL(path,'') FROM materials"):
            if body and body not in meta and (title or path):
                meta[body] = (title, path)

        groups = {}          # mid -> {body, ref, qids, papers}
        for qid, body, ref, region, year, paper in rows:
            mid = fingerprint(body)
            g = groups.get(mid)
            if g is None:
                g = groups[mid] = {"body": body, "ref": ref, "qids": [], "papers": set()}
            # ref_label 取最长的那个：编号各家不同，信息量最大的那个最好认
            if len(ref) > len(g["ref"]):
                g["ref"] = ref
            g["qids"].append(qid)
            g["papers"].add((region, year, paper))

        conn.execute("DELETE FROM materials")
        conn.executemany(
            """INSERT INTO materials(mid, title, body, path, img_refs, has_image, n_q, n_paper)
               VALUES(?,?,?,?,?,?,?,?)""",
            [(mid,
              (meta.get(g["body"], ("", ""))[0] or _ref_label(g["ref"], g["body"])),
              g["body"],
              meta.get(g["body"], ("", ""))[1],
              ",".join(sorted(set(IMG_SRC.findall(g["body"])))),
              1 if IMG_SRC.search(g["body"]) else 0,
              len(g["qids"]), len(g["papers"]))
             for mid, g in groups.items()])

        # 回填 questions.material_id（executemany 走一条预编译语句，27k 行也就一秒）
        conn.executemany("UPDATE questions SET material_id=? WHERE id=?",
                         [(mid, qid) for mid, g in groups.items() for qid in g["qids"]])
        conn.execute("CREATE INDEX IF NOT EXISTS idx_q_matid ON questions(material_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mat_nq ON materials(n_q DESC)")
        conn.commit()

        if not quiet:
            dup = len(rows) - len(groups)
            reused = sum(1 for g in groups.values() if len(g["papers"]) > 1)
            multi = sum(1 for g in groups.values() if len(g["qids"]) > 1)
            saved = sum(len(g["body"]) * (len(g["qids"]) - 1) for g in groups.values())
            print("[materials] %d 道有材料的题 → %d 段材料（合并掉 %d 份重复文本，约 %.1f MB）"
                  % (len(rows), len(groups), dup, saved / 1048576.0))
            print("[materials] 其中 %d 段挂在多道题下、%d 段被多份试卷复用"
                  % (multi, reused))
        return len(groups)
    finally:
        conn.close()


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else None)
