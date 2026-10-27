# Gherkin 驗收情境（收件匣）

這個資料夾放「自動驗收」用的 Gherkin 情境。外部 TDD 工具產生的結果，直接放進來就好。

## 怎麼放進來（三選一）

1. **在 GitHub 網頁上傳**：打開 repo → 進 `docs/features/` → **Add file → Upload files** → 拖進 `.feature` 或 `.md` 檔 → **Commit changes**。下次開 Claude Code 對話就讀得到。
2. **貼給 Claude**：在對話裡說「收 Gherkin」，把內容整段貼上，總管會原封不動存成 `docs/features/<SDD編號>-<名稱>.feature`。
3. **開對話時附檔**：把檔案拖進對話框，說「收進 docs/features」。

## 規則

- 檔名用對應的 SDD 編號開頭，例如 `001-比價.feature`，方便對照。
- 可以收：`.feature` 檔；或 `.md` 檔裡的 ```gherkin 區塊（一個檔可以有好幾塊）。
- 關鍵字英文、繁中、簡中都可以（Feature／功能、Scenario／場景、Scenario Outline／場景大綱、Examples／例子、Given／假如、When／當、Then／那麼、And／而且、But／但是），冒號全形半形都可以。
- 情境是**驗收標準**：子代理都不能改（hook 會擋）。要改情境，回外部工具改完再放進來。
- 檔名以 `_` 開頭的檔案不會被執行（可以拿來暫放）。

## 跑驗收

- 總管會在 builder 做完後自動派 `tester` 跑。
- 手動跑：`node tests/gherkin/run.cjs`；只檢查步驟定義：`node tests/gherkin/run.cjs --dry`。
- 結果在 `results/latest.md`（給人看）和 `results/latest.json`（給 hook 看）。
