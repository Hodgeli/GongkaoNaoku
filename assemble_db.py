#!/usr/bin/env python3
"""合并分卷题库：kaogong.db.part-00..NN -> kaogong.db（克隆后运行一次即可）

合并完成后会自动套用 data/fixups.json 里的逐题修正补丁（见 fixups.py），
把材料归并成独立的 materials 表（见 materials.py），
最后重建全文索引（见 search.py）。
"""
import glob, os, shutil, sys

here = os.path.dirname(os.path.abspath(__file__))
parts = sorted(glob.glob(os.path.join(here, "kaogong.db.part-*")))
if not parts:
    sys.exit("未找到分卷文件 kaogong.db.part-*，请确认在仓库目录内运行。")
out = parts[0].split(".part-")[0]
with open(out, "wb") as f:
    for p in parts:
        with open(p, "rb") as g:
            shutil.copyfileobj(g, f, 1024*1024*8)
print(f"已生成 {out}（{os.path.getsize(out)//1048576} MB，来自 {len(parts)} 个分卷）。")

# 套用数据修正补丁（幂等；失败不影响主流程，但要让人看见）
sys.path.insert(0, here)
try:
    import fixups
    n = fixups.apply(out)
    if n:
        print(f"已应用题库修正补丁 {n} 行（data/fixups.json）。")
except Exception as e:
    print(f"[WARN] 题库修正补丁未应用：{e}")

# 材料独立成表（必须在 fixups 之后：补丁补的材料也要一起归并进 materials）
try:
    import materials
    materials.build(out)
except Exception as e:
    print(f"[WARN] 材料表构建失败：{e}")

# 全文索引（必须最后跑：fixups 改过题干/解析，索引要基于最终内容重建）
try:
    import search
    search.build(out)
except Exception as e:
    print(f"[WARN] 全文索引构建失败：{e}")

print("现在可以运行 python3 server.py")
