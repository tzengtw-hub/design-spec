#!/usr/bin/env python3
# Stop hook：總管要結束這一輪回覆「之前」檢查 Gherkin 驗收。
#
# docs/features/ 有情境時，網站、情境或步驟定義只要有變，
# 就一定要重跑驗收而且全部通過，才准結束；否則擋下來，請總管派 tester。
# 沒有任何情境（前幾堂課）就完全不管。
import json, os, subprocess, sys

root = os.environ.get("CLAUDE_PROJECT_DIR", ".")
os.chdir(root)
data = json.load(sys.stdin)

def block(reason):
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
    sys.exit(0)

feature_dir = "docs/features"
has_features = os.path.isdir(feature_dir) and any(
    (f.endswith(".feature") or (f.endswith(".md") and f.lower() != "readme.md")) and not f.startswith("_")
    for f in os.listdir(feature_dir))
if not has_features:
    sys.exit(0)

# 用執行器算出「現在」的指紋，和上次驗收結果比對
try:
    out = subprocess.run(["node", "-e",
        "console.log(JSON.stringify(require('./tests/gherkin/run.cjs').fingerprint()))"],
        capture_output=True, text=True, timeout=30)
    now = json.loads(out.stdout)
except Exception:
    sys.exit(0)                               # 算不出來就不擋，避免卡死

try:
    last = json.load(open(os.path.join(feature_dir, "results", "latest.json"), encoding="utf-8"))
except Exception:
    last = None

if last and last.get("fingerprint") == now and last.get("ok"):
    sys.exit(0)                               # 驗收過了，而且之後沒再改

if data.get("stop_hook_active"):
    # 已經擋過一次還是沒過：不再擋（避免無限循環），但提醒總管照實回報
    print("Gherkin 驗收仍未通過，請在回覆中照實告訴使用者。", file=sys.stderr)
    sys.exit(0)

if not last or last.get("fingerprint") != now:
    block("Gherkin 驗收還沒跑（網站、情境或步驟定義有變動）。請派子代理 tester 執行 "
          "`node tests/gherkin/run.cjs`，再依 docs/features/results/latest.md 回報。")
block("Gherkin 驗收沒有全部通過，請看 docs/features/results/latest.md："
      "網站的問題派 builder 修，缺步驟定義派 tester 補，修完再跑一次。")
