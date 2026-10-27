# CC 初級課・學員範本

你不需要會寫程式，全程只用**瀏覽器**（最後一堂加上手機）。這個範本給你一個空的小網站，加上讓 Claude 守規矩的說明書。你會用**自己的題目**，在課堂上把它做成一個單頁網站。

## 開課前：四步

| 步驟 | 做什麼 | 做完你應該看到 |
|---|---|---|
| 1 | 登入 claude.ai，確認是 **Pro** 或 **Team** 方案 | 打開 **claude.ai/code** 能進去，不是「無權限」 |
| 2 | 開一個 **GitHub 帳號**（免費）：github.com | 登入後看到 GitHub 首頁 |
| 3 | 在這個頁面按綠色 **Use this template → Create a new repository**，名稱用英文（例如 `my-first-site`），選 **Private** | 你的帳號底下多了一個 repo，裡面有 `README.md`、`CLAUDE.md`、`index.html` |
| 4 | 到 claude.ai/code，依畫面連結 GitHub，選剛建的 repo，開一個對話說「你好，這個專案有什麼？」 | Claude 用白話介紹這個專案 |

## 這裡面有什麼（你不用打開，Claude 會讀）

這一套叫駕馭設定（**harness**）：讓 Claude 照規矩做事的整套設定。白話說就是「員工手冊＋分工＋門禁＋檔案櫃」。

| 檔案 | 白話 | 是什麼 |
|---|---|---|
| `CLAUDE.md` | 員工手冊 | Claude 每次開工先讀的規則：它是總管，不自己寫程式 |
| `.claude/agents/builder.md`、`tester.md`、`checker.md` | 分工 | 三個小幫手：builder 照規格做、tester 開瀏覽器照 Gherkin 自動測、checker 照規格驗收 |
| `.claude/hooks/`、`.claude/settings.json` | 門禁 | 自動檢查：總管自己改網站、沒有確認過的規格就動手、改了網站沒跑驗收就想收工，都會被擋下 |
| `docs/sdd/` | 施工單 | 每個功能的規格（規格驅動開發，Spec-Driven Development，SDD） |
| `docs/adr/` | 會議決議 | 重要決定與理由（架構決策紀錄，Architecture Decision Record，ADR） |
| `docs/features/` | 驗收考卷 | Gherkin 情境（外部工具產生，放進來就自動驗收，見裡面的 README） |
| `index.html` | 你的網站 | 目前是空的 |
| `wrangler.jsonc`、`package.json`、`.assetsignore` | 上線工具 | 課後選用：照 `docs/deploy.md` 設定一次，之後說「上線」就放到正式網址 |

## 怎麼看到網站、怎麼存檔

- **草稿**：做完一個功能，跟 Claude 說「**給我看網站**」，它會發佈一個只有你看得到的預覽網址（成品頁，Artifact），電腦和手機都能打開。
- **存檔**：說「**收工**」，照指示開合併請求（Pull Request）、合併（Merge）。驗收已經在對話裡跑過了，GitHub 這邊不檢查。合併後，下一堂開新對話就接得上今天的成果。
- 你的程式碼和每一次改動的紀錄，都在你自己的 GitHub repo 裡。這門課不教上線（deploy），網站只放假資料。
