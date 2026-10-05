#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成"仿真实综测公示表"夹具。

## 为什么必须专门造一个

真实文件 `25级综测成绩*.xlsx` 里踩出了三个坑，而我原先的夹具一个都没覆盖：

  1. **三行合并表头 + 宽数据行**：表头有大量合并单元格（值只在左上角），
     所以"非空格数"远少于视觉宽度；而数据行 37 列几乎填满。
     用宽度认表头，必然认到第一行数据上去，于是第一名学生被当表头吃掉。
  2. **一个班一张工作表**：四张表共 147 人。只读"找到列的那张表"就只剩 57 人，
     而预览页看起来完全正常 —— 静默丢数据是最坏的一类错误。
  3. **几乎全空的列**：真实表里有一列只有 1 个非空值。只看"数字占比"的话，
     它 100% 的占比能击败有 57 个值、98.2% 的真正成绩列。

真实文件不能进仓库（含学生姓名与学号），所以这里用**假数据造出同样的形状**。
形状对了，坑才会被重新踩到。

    python tests/fixtures/make-fixtures.py
"""

import os

from openpyxl import Workbook
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))

SURNAMES = "张王李赵陈刘杨黄周吴徐孙马朱胡林郭何高罗"
GIVEN = "伟芳娜秀敏静丽强磊洋艳勇军杰娟涛明超霞平刚桂英"


def fake_name(seed: int) -> str:
    return SURNAMES[seed % len(SURNAMES)] + GIVEN[(seed * 7) % len(GIVEN)] + GIVEN[(seed * 13) % len(GIVEN)]


# 与真实表逐列对齐的布局（A..AK，共 37 列）
GROUPS = [
    ("A1（社会公德（6分）", ["志愿服务立项及开展\n（4分）", "日常志愿服务及社会服务奉献\n（2分）"]),
    ("A2（学生工作）（18分）", ["学生干部任职加分\n（6分）", "参与学生工作情况（12分）", "", ""]),
    ("A3（党团活动）（13分）", ["党建活动\n（3分）", "团建活动\n（10分）", "", "", ""]),
    ("A4（公寓建设）（16分）", ["寝室检查\n（12分）", "校、院级的公寓文化节活动\n（2分）", "星级寝室评比\n（2分）"]),
    ("A5（社会实践）（8分）", ["立项加分\n（2分）", "社会实践报告          （6分）", ""]),
    ("A6（遵纪守法） （6分）", ["", "", ""]),
    ("A7（校园文化活动）\n（25分）", ["社团\n（3分）", "文艺类\n（5分）", "体育类\n（6分）", "创新创业类\n（3分）", "其他素质能力\n（8分）"]),
    ("A8易班工作（8分）", ["个人活跃度（2分）", "易班APP线上活动\n（4分）", "易班线下活动（2分）"]),
]

# 第 4 行（三级表头）的补丁：列号 → 文本
ROW4 = {
    7: "主管部门评定（6分）", 8: "班级评定（4分）", 9: "劳动\n（2分）",
    11: "班团活动\n（5分）", 13: "青年大学习（3分）", 14: "突出贡献  （2分）",
    19: "团体社会实践\n（3分）", 20: "个人社会实践\n（3分）",
}


def zongce_like():
    """一份形状与真实综测公示表一致的假数据文件。"""
    wb = Workbook()
    wb.remove(wb.active)

    # 三个班，每班 20 人；最后一个班刻意放一条重复学号
    classes = [("计算机9901", "41990101"), ("大数据9901", "41990301"), ("信计9901", "41990401")]
    duplicate_placed = False

    for sheet_index, (class_name, prefix) in enumerate(classes):
        ws = wb.create_sheet(f"{class_name}综测成绩")

        # ---- 第 1 行：标题（只占一格，跨全表） ----
        ws["A1"] = f"2024-2025年秋季学期计算机学院{class_name}班级综合测评成绩公示"
        ws.merge_cells("A1:AK1")

        # ---- 第 2 行：大类（横向合并） ----
        ws["A2"] = "学号"
        ws["B2"] = "姓名"
        ws["C2"] = "班级"
        ws.merge_cells("A2:A4")
        ws.merge_cells("B2:B4")
        ws.merge_cells("C2:C4")

        col = 4
        for group_name, leaves in GROUPS:
            start = col
            end = col + len(leaves) - 1
            ws.cell(row=2, column=start, value=group_name)
            if end > start:
                ws.merge_cells(
                    start_row=2, start_column=start,
                    end_row=2, end_column=end,
                )
            col = end + 1

        ws.cell(row=2, column=32, value="A\n（100分）")
        ws.cell(row=2, column=33, value="A*0.3")
        ws.cell(row=2, column=34, value="B\n（100分）")
        ws.cell(row=2, column=35, value="B*0.7")
        ws.cell(row=2, column=36, value="C")
        ws.cell(row=2, column=37, value="S=A*0.3+B*0.7+C")
        for c in range(32, 38):
            ws.merge_cells(start_row=2, start_column=c, end_row=4, end_column=c)

        # ---- 第 3 行：叶子项 ----
        col = 4
        for group_name, leaves in GROUPS:
            for i, leaf in enumerate(leaves):
                if leaf:
                    ws.cell(row=3, column=col + i, value=leaf)
            col += len(leaves)

        # ---- 第 4 行：三级项 ----
        for column, text in ROW4.items():
            ws.cell(row=4, column=column, value=text)

        # 二级项纵向合并到第 4 行
        for c in (4, 5, 6, 10, 12, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31):
            ws.merge_cells(start_row=3, start_column=c, end_row=4, end_column=c)

        # ---- 数据行 ----
        for i in range(20):
            r = 5 + i
            sid = f"{prefix}{i + 1:02d}"
            ws.cell(row=r, column=1, value=sid).number_format = "@"
            ws.cell(row=r, column=2, value=fake_name(sheet_index * 20 + i))
            ws.cell(row=r, column=3, value=class_name)

            # 计分项：大部分是 0/1/2.5 这类小数字，撑起"宽数据行"
            for c in range(4, 32):
                # 第 12 列（L）刻意绝大多数留空 —— 复现"只有 1 个值的列"
                if c == 12 and not (sheet_index == 0 and i == 0):
                    continue
                ws.cell(row=r, column=c, value=round(((i + c) % 5) * 0.5, 1))

            a_total = round(30 + i * 1.3, 2)
            b_score = round(70 + i * 1.1, 4)
            ws.cell(row=r, column=32, value=a_total)
            ws.cell(row=r, column=33, value=round(a_total * 0.3, 2))
            ws.cell(row=r, column=34, value=b_score)
            ws.cell(row=r, column=35, value=round(b_score * 0.7, 2))
            ws.cell(row=r, column=36, value=0)
            ws.cell(row=r, column=37, value=round(a_total * 0.3 + b_score * 0.7, 2))

        # 第一张表的最后一行：复现"同一学号对应两个不同的人"
        if sheet_index == 0 and not duplicate_placed:
            r = 25
            ws.cell(row=r, column=1, value=f"{prefix}01").number_format = "@"
            ws.cell(row=r, column=2, value="重名学生")
            ws.cell(row=r, column=3, value=class_name)
            for c in range(4, 32):
                ws.cell(row=r, column=c, value=0)
            ws.cell(row=r, column=32, value=10)
            ws.cell(row=r, column=34, value=60)
            duplicate_placed = True

    path = os.path.join(HERE, "zongce-like.xlsx")
    wb.save(path)
    print("生成 zongce-like.xlsx（形状仿真实综测公示表，数据为假的）")


if __name__ == "__main__":
    zongce_like()
    print("已生成于", HERE)
