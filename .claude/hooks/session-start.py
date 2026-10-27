#!/usr/bin/env python3
# SessionStart hook：每次開工（新對話、接續、/clear、壓縮後）自動告訴 Claude
#   1. 它的角色是總管
#   2. 目前有哪些 SDD（規格）和 ADR（決策紀錄）
# 這樣不用靠 Claude「記得」去讀，一開工就看得到。
import glob, json, os, re

os.chdir(os.environ.get("CLAUDE_PROJECT_DIR", "."))

def title_and_status(path):
    title, status = os.path.basename(path), ""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f.read().splitlines()[:12]:
                if line.startswith("# ") and title == os.path.basename(path):
                    title = line[2:].strip()
                m = re.search(r"狀態[:：]\s*(\S+)", line)
                if m:
                    status = m.group(1)
    except OSError:
        pass
    return title, status

lines = ["這個專案使用 CC 初級課的 harness。",
         "主對話的角色是總管：不直接修改網站檔案，寫程式派給子代理 builder，自動驗收派給 tester，對照規格派給 checker。"]

sdds = [p for p in sorted(glob.glob("docs/sdd/*.md")) if not os.path.basename(p).startswith("_")]
if sdds:
    lines.append("目前的 SDD：")
    for p in sdds:
        t, s = title_and_status(p)
        lines.append(f"- {p}：{t}（狀態：{s or '未標示'}）")
else:
    lines.append("目前還沒有任何 SDD。使用者要做功能時，請他先在 claude.ai 或規格工具寫好規格貼過來；你不要自己訪談或起草。")

adrs = [p for p in sorted(glob.glob("docs/adr/*.md")) if not os.path.basename(p).startswith("_")]
if adrs:
    lines.append("目前的 ADR：")
    for p in adrs:
        t, s = title_and_status(p)
        lines.append(f"- {p}：{t}（狀態：{s or '未標示'}）")

feats = [p for p in sorted(glob.glob("docs/features/*.feature") + glob.glob("docs/features/*.md"))
         if not os.path.basename(p).startswith("_") and os.path.basename(p).lower() != "readme.md"]
if feats:
    lines.append("Gherkin 驗收情境（改完網站要派 tester 跑 `node tests/gherkin/run.cjs`）：")
    lines += [f"- {p}" for p in feats]
    try:
        r = json.load(open("docs/features/results/latest.json", encoding="utf-8"))
        lines.append(f"上次驗收：通過 {r.get('passed')}／共 {r.get('total')} 個情境。")
    except Exception:
        lines.append("還沒跑過驗收。")

print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                         "additionalContext": "\n".join(lines)}}, ensure_ascii=False))
