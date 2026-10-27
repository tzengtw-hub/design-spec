#!/usr/bin/env python3
# PreToolUse hook：在 Claude 改檔案或跑指令「之前」檢查，違規就擋下並說明原因。
#
# 六條規則：
#   1. 總管不寫程式：主對話不能改 docs/、CLAUDE.md、README.md 以外的檔案，要派給 builder。
#   2. 只有 builder 能改網站檔案。
#   3. 先有規格才動手：builder 改網站前，docs/sdd/ 至少要有一份「已確認」的 SDD，
#      而且 SDD 裡提到的 ADR 檔案都要存在。
#   4. 保護 harness：要改 .claude/ 裡的設定，一律先問使用者。
#   5. 驗收規格不能被改：docs/features/ 的 Gherkin 情境是外部工具產生的，子代理都不能改；
#      驗收結果（docs/features/results/）只能由執行器寫，誰都不能手改。
#   6. 只有 tester 能寫測試步驟（tests/）；tester 不能改網站，builder 不能改測試。
#
# 誠實說明：這只擋得住「明顯」的違規。Claude 若刻意繞路仍可能繞過，
# hook 的價值是讓偷懶被抓到、留下紀錄，不是銅牆鐵壁。
import glob, json, os, re, sys

os.chdir(os.environ.get("CLAUDE_PROJECT_DIR", "."))

data = json.load(sys.stdin)
tool = data.get("tool_name", "")
ti = data.get("tool_input", {}) or {}
agent = data.get("agent_type") or ""          # 子代理名稱；主對話（總管）沒有這個欄位
is_boss = not data.get("agent_id")
root = os.path.realpath(os.environ.get("CLAUDE_PROJECT_DIR", "."))

def decide(decision, reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
          "permissionDecision": decision, "permissionDecisionReason": reason}}, ensure_ascii=False))
    sys.exit(0)

def sdd_problem():
    sdds = [p for p in glob.glob("docs/sdd/*.md") if not os.path.basename(p).startswith("_")]
    if not sdds:
        return "docs/sdd/ 裡還沒有任何 SDD。請總管先和使用者寫好規格，再派 builder。"
    confirmed = []
    for p in sdds:
        text = open(p, encoding="utf-8").read()
        if re.search(r"狀態[:：]\s*(已確認|已完成)", text):
            confirmed.append(p)
        for n in re.findall(r"ADR-(\d{4})", text):
            if not glob.glob(f"docs/adr/{n}-*.md"):
                return f"{p} 提到 ADR-{n}，但 docs/adr/ 找不到 {n}-*.md。請總管先把 ADR 寫好。"
    if not confirmed:
        return "所有 SDD 都還是草稿。請總管先請使用者確認規格，把狀態改成「已確認」。"
    return None

def classify(path):
    full = os.path.realpath(path if os.path.isabs(path) else os.path.join(root, path))
    if not full.startswith(root + os.sep):
        return "outside"                      # 專案外（例如預覽用的暫存檔）不管
    rel = os.path.relpath(full, root)
    if rel.startswith(".claude" + os.sep):
        return "harness"
    if rel.startswith(os.path.join("docs", "features", "results") + os.sep):
        return "results"
    if rel.startswith(os.path.join("docs", "features") + os.sep):
        return "features"
    if rel.startswith("tests" + os.sep):
        return "tests"
    if rel.startswith("docs" + os.sep) or rel in ("CLAUDE.md", "README.md"):
        return "docs"
    return "code"

if tool == "Bash":
    cmd = ti.get("command", "")
    writes = re.search(r"(>|\btee\b|\bsed\s+-i|\bcp\b|\bmv\b|\brm\b)", cmd)
    code_file = re.search(r"\.(html?|css|js|jsx|ts)\b", cmd)
    if is_boss and writes and code_file:
        decide("deny", "總管不寫程式：不能用指令改網站檔案。請把這件事派給子代理 builder。")
    if agent and agent != "builder" and writes and code_file:
        decide("deny", "只有 builder 可以改網站檔案（現在是 " + agent + "）。")
    if not is_boss and writes and "docs/features" in cmd:
        decide("deny", "Gherkin 情境和驗收結果不能用指令改（要看結果請直接讀檔）。")
    if not is_boss and agent != "tester" and writes and "tests/" in cmd:
        decide("deny", "測試步驟只能由子代理 tester 寫。")
    if ".claude/" in cmd and writes:
        decide("ask", "這個指令會動到 .claude/（harness 設定）。請使用者確認。")
    sys.exit(0)

path = ti.get("file_path") or ti.get("notebook_path") or ""
if not path:
    sys.exit(0)
kind = classify(path)

if kind == "harness":
    decide("ask", "要修改 .claude/ 裡的 harness 設定（hooks、子代理）。請使用者確認。")
if kind in ("outside", "docs"):
    sys.exit(0)
if kind == "results":
    decide("deny", "驗收結果只能由 `node tests/gherkin/run.cjs` 產生，不能手改。")
if kind == "features":
    if is_boss:
        sys.exit(0)                           # 總管可以把使用者貼來的情境「原封不動」存進來
    decide("deny", "Gherkin 情境是驗收標準，由外部工具產生，子代理不能改。覺得情境有問題，請回報總管。")
if kind == "tests":
    if agent == "tester":
        sys.exit(0)
    who = "總管" if is_boss else (agent or "子代理")
    decide("deny", "測試步驟只能由子代理 tester 寫（現在是 " + who + "）。")

# 以下是網站檔案（code）
if is_boss:
    decide("deny", "總管不寫程式：主對話不能直接改 " + os.path.basename(path) + "。請把工作派給子代理 builder，交代要做的功能和 SDD 路徑。")
if agent != "builder":
    decide("deny", "只有 builder 可以改網站檔案（現在是 " + (agent or "未知子代理") + "）。")
problem = sdd_problem()
if problem:
    decide("deny", problem)
sys.exit(0)
