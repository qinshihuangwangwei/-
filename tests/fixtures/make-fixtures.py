#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成导入测试用的表格夹具。

刻意包含"难看的"真实情形 —— 多工作表、合并表头、学号存成文本、
混入身份证号列、空单元格。导入逻辑只有被这些东西打过，才算真的能用。

    python tests/fixtures/make-fixtures.py

生成的文件会提交进仓库，因为测试要能脱离 Python 环境运行。
"""

import os
import csv

from openpyxl import Workbook
from openpyxl.styles import Alignment

HERE = os.path.dirname(os.path.abspath(__file__))

# 名册夹具用**假名**。
#
# 这里原来写的是真实的 25 级学生姓名（那份名单是从教务导出来的真名册）。
# 夹具会被截图、会被引用、会被当成样例，一个真名落进去就再也收不回来了。
# 学号保持原样（它们是结构的一部分，测试要靠它对齐），姓名一律换成编的。
STUDENTS = [
    ("2599000001", "赵雨桐", "计算机2501"),
    ("2599000002", "李海燕", "计算机2501"),
    ("2599000003", "周雅静", "计算机2501"),
    ("2599000004", "黄秀英", "计算机2501"),
    ("2599000005", "孙志强", "计算机2501"),
    ("2599000017", "徐俊宇", "大数据2501"),
    ("2599000018", "何一鸣", "大数据2501"),
    ("2599000020", "高子涵", "信计2501"),
    ("2599000021", "林浩然", "信计2501"),
    ("2599000024", "阿迪拉·艾山", "人工智能2501"),
]


def save(wb, name):
    path = os.path.join(HERE, name)
    wb.save(path)
    print("生成", name)


# ---------------------------------------------------------------------------
# 1. 名册：干净的三列
# ---------------------------------------------------------------------------
def roster_ok():
    wb = Workbook()
    ws = wb.active
    ws.title = "学生名册"
    ws.append(["学号", "姓名", "班级"])
    for sid, name, cls in STUDENTS:
        # 学号写成文本，模拟"从教务系统导出后再存"
        ws.append([sid, name, cls])
        ws.cell(row=ws.max_row, column=1).number_format = "@"
    save(wb, "roster-ok.xlsx")


# ---------------------------------------------------------------------------
# 2. 名册：前面有标题行，学号存成数字（前导零会丢的那种坑）
# ---------------------------------------------------------------------------
def roster_with_title():
    wb = Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    ws.append(["计算机学院 2025 级学生名册"])
    ws.append([])
    ws.append(["序号", "学号", "姓名", "班级", "备注"])
    for i, (sid, name, cls) in enumerate(STUDENTS, start=1):
        ws.append([i, int(sid), name, cls, None])
    save(wb, "roster-with-title.xlsx")


# ---------------------------------------------------------------------------
# 3. B 项成绩：干净的两列
# ---------------------------------------------------------------------------
def bscore_ok():
    wb = Workbook()
    ws = wb.active
    ws.title = "成绩"
    ws.append(["学号", "B分"])
    for i, (sid, _, _) in enumerate(STUDENTS):
        ws.append([sid, round(60 + i * 3.7, 4)])
        ws.cell(row=ws.max_row, column=1).number_format = "@"
    save(wb, "bscore-ok.xlsx")


# ---------------------------------------------------------------------------
# 4. B 项成绩：仿真实综测表 —— 三行合并表头、多列、空单元格
# ---------------------------------------------------------------------------
def bscore_realistic():
    wb = Workbook()
    ws = wb.active
    ws.title = "计算机2501综测成绩"

    ws["A1"] = "2024-2025年秋季学期计算机学院计算机2501班级综合测评成绩公示"
    ws.merge_cells("A1:H1")

    headers = [
        ("A2", "A3", "学号"),
        ("B2", "B3", "姓名"),
        ("C2", "C3", "班级"),
        ("D2", "D3", "A1（社会公德）"),
        ("E2", "E3", "A7（校园文化活动）"),
        ("F2", "F3", "A（100分）"),
        ("G2", "G3", "B（100分）"),
        ("H2", "H3", "S"),
    ]
    for top, bottom, text in headers:
        ws[top] = text
        ws.merge_cells(f"{top}:{bottom}")

    for i, (sid, name, cls) in enumerate(STUDENTS):
        r = i + 4
        ws.cell(row=r, column=1, value=sid).number_format = "@"
        ws.cell(row=r, column=2, value=name)
        ws.cell(row=r, column=3, value=cls)
        ws.cell(row=r, column=4, value=round(2 + i * 0.4, 2))
        # 刻意留一个空单元格：xlsx 会整格省略它，按出现顺序数就会错位
        if i % 3 != 0:
            ws.cell(row=r, column=5, value=round(1 + i * 0.5, 2))
        ws.cell(row=r, column=6, value=round(30 + i * 1.3, 2))
        ws.cell(row=r, column=7, value=round(70 + i * 2.1, 4))
        ws.cell(row=r, column=8, value=round(60 + i * 1.8, 4))

    save(wb, "bscore-realistic.xlsx")


# ---------------------------------------------------------------------------
# 5. B 项成绩：学号列其实是身份证号（用来验证命中率诊断）
# ---------------------------------------------------------------------------
def bscore_idcard():
    wb = Workbook()
    ws = wb.active
    ws.title = "成绩"
    ws.append(["身份证号", "学号", "综合成绩"])
    for i, (sid, _, _) in enumerate(STUDENTS):
        fake_id = f"3301022006010{i:03d}0"
        ws.append([fake_id, sid, round(55 + i * 4.2, 2)])
        ws.cell(row=ws.max_row, column=2).number_format = "@"
    save(wb, "bscore-idcard.xlsx")


# ---------------------------------------------------------------------------
# 6. B 项成绩：多工作表，成绩在第二张表
# ---------------------------------------------------------------------------
def bscore_multi_sheet():
    wb = Workbook()
    first = wb.active
    first.title = "说明"
    first.append(["本文件由教务系统导出"])
    first.append(["如有疑问请联系教务处"])

    second = wb.create_sheet("成绩明细")
    second.append(["学号", "姓名", "学业成绩"])
    for i, (sid, name, _) in enumerate(STUDENTS):
        second.append([sid, name, round(58 + i * 3.3, 2)])
        second.cell(row=second.max_row, column=1).number_format = "@"

    save(wb, "bscore-multi-sheet.xlsx")


# ---------------------------------------------------------------------------
# 7. B 项成绩：完全对不上（学号是乱编的）
# ---------------------------------------------------------------------------
def bscore_no_match():
    wb = Workbook()
    ws = wb.active
    ws.title = "成绩"
    ws.append(["学号", "B分"])
    for i in range(10):
        ws.append([f"99999{i:05d}", round(60 + i, 2)])
        ws.cell(row=ws.max_row, column=1).number_format = "@"
    save(wb, "bscore-no-match.xlsx")


# ---------------------------------------------------------------------------
# 8. CSV：带 BOM、带引号内换行
# ---------------------------------------------------------------------------
def roster_csv():
    path = os.path.join(HERE, "roster-bom.csv")
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["学号", "姓名", "班级"])
        for sid, name, cls in STUDENTS:
            writer.writerow([sid, name, cls])
    print("生成 roster-bom.csv")


if __name__ == "__main__":
    roster_ok()
    roster_with_title()
    bscore_ok()
    bscore_realistic()
    bscore_idcard()
    bscore_multi_sheet()
    bscore_no_match()
    roster_csv()
    print("全部夹具已生成于", HERE)
