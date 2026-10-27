# 課後小抄：把網站放上正式網址（選用）

課堂上用「給我看網站」預覽就夠了。想要一個能傳給同事的正式網址時，照下面做一次，之後每次只要跟 Claude 說「**上線**」。

範本已經裝好上線工具 Wrangler（Cloudflare 的命令列部署工具），只會上傳 `index.html`，其他檔案（規格、測試、設定）不會上傳。

> 金鑰的規矩：**金鑰只放在第 5 步的環境設定裡**。不要貼進對話、不要寫進任何檔案、不要提交到 GitHub。

| 步驟 | 做什麼 | 做完你應該看到 |
|---|---|---|
| 1 | 到 `dash.cloudflare.com/sign-up` 開一個 Cloudflare 帳號（免費），收信驗證 | 登入後看到 Cloudflare 主控台 |
| 2 | 左邊選單點 **Workers & Pages**（第一次進去會幫你建好 `你的名字.workers.dev` 子網域） | Workers & Pages 的頁面打得開 |
| 3 | 複製帳號編號（Account ID）：在 **Workers & Pages** 頁面右側，或主控台首頁帳號名稱旁的選單 **Copy account ID** | 一串 32 個英數字，先貼在記事本 |
| 4 | 建金鑰：右上角頭像 → **My Profile → API Tokens → Create Token**，範本選 **Edit Cloudflare Workers** → **Use template**；Account Resources 選你的帳號 → **Continue to summary → Create Token**，按複製 | 一串金鑰（只會顯示這一次），先貼在記事本 |
| 5 | 到 `claude.ai/code`，在輸入框下方的環境選單選 **Add environment**（已經有自己的環境就按旁邊的齒輪編輯）：名稱填 `上線用`；**Network access** 選 **Custom**，Allowed domains 填 `api.cloudflare.com`，勾 **Also include default list of common package managers**；**Environment variables** 填下面兩行（換成你的值），按 **Add environment** | 環境選單裡多了「上線用」 |
| 6 | 選這個 repo、環境選「上線用」，開一個新對話，說「**上線**」 | Claude 回你一個 `https://….workers.dev` 網址 |
| 7 | 打開那個網址（第一次可能要等一兩分鐘） | 你的網站，手機也打得開 |

第 5 步的環境變數（`=` 後面換成你記事本裡的值）：

```
CLOUDFLARE_API_TOKEN=第4步的金鑰
CLOUDFLARE_ACCOUNT_ID=第3步的帳號編號
```

## 之後

- 改完網站、收工合併後，在「上線用」環境開對話說「上線」，正式網址就更新。
- 環境變數**用這個環境的人都看得到**。如果你的 claude.ai 帳號跟別人共用，不要這樣設定，請講師幫你上線。
- 不想用了：到 Cloudflare **My Profile → API Tokens** 把金鑰刪掉（Roll 或 Delete），再把 claude.ai 的「上線用」環境封存（Archive）。
- 網站是公開的，任何拿到網址的人都打得開，所以一樣只放假資料。

## 卡住了

| 狀況 | 怎麼辦 |
|---|---|
| Claude 說找不到金鑰 | 開對話時環境沒選「上線用」，或第 5 步的變數名稱打錯 |
| `fetch failed`、連不到 `api.cloudflare.com` | 第 5 步的 Network access 沒選 Custom，或 Allowed domains 沒填 `api.cloudflare.com` |
| `Authentication error` | 金鑰複製不完整，或第 4 步沒選 Edit Cloudflare Workers 範本；重建一把金鑰換掉 |
| 網址打不開 | 第一次上線等一兩分鐘再試 |
