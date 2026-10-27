# 本機開發與後台設定（給開發者看的小抄）

> 對應 SDD-001、ADR-0001、ADR-0002。
> 這份文件**不放任何真實金鑰**。金鑰只放在你自己電腦的環境設定，不貼進對話、不提交。

## 0. 這個系統由哪幾塊組成

| 部分 | 放在哪 | 白話說明 |
|---|---|---|
| 前端畫面 | `public/index.html` | 使用者看到的網頁 |
| 後端程式 | `src/worker.js` | Cloudflare Worker（在 Cloudflare 上跑的小程式），負責查資料、檢查權限 |
| 資料庫 | Cloudflare D1 | 雲端的表格式資料庫，名稱 `yacht-order` |
| 資料表結構 | `migrations/0001_init.sql` | 遷移檔（migration）：建立資料表的指令，照順序套用 |
| 假資料 | `migrations/seed_demo.sql` | 示範用的假帳號和假專案（@example.com） |
| 登入 | Cloudflare Access | Cloudflare 的登入關卡，先驗證身分才放行 |
| 設定 | `wrangler.jsonc` | 告訴 Wrangler 後端在哪、前端在哪、資料庫是哪一個 |

根目錄的 `index.html` 只是說明頁，不會上線。

## 1. 安裝工具（第一次才要）

```bash
npm install
```

這會裝好 Wrangler（Cloudflare 的命令列工具），版本寫在 `package.json`。

## 2. 建立 D1 資料庫（第一次才要，需要 Cloudflare 帳號）

```bash
npx wrangler login            # 用瀏覽器登入 Cloudflare（或照 docs/deploy.md 設好環境變數）
npx wrangler d1 create yacht-order
```

指令會印出一段設定，裡面有 `database_id`。把它貼到 `wrangler.jsonc`，取代 `REPLACE_WITH_D1_ID`。

> 只在本機試的話，可以先跳過這步，佔位字串也能跑本機資料庫。

## 3. 建資料表、灌假資料

本機（資料存在你電腦的 `.wrangler/` 資料夾，不會動到雲端）：

```bash
npx wrangler d1 execute yacht-order --local --file=migrations/0001_init.sql
npx wrangler d1 execute yacht-order --local --file=migrations/seed_demo.sql
```

雲端（測試環境）：把上面的 `--local` 換成 `--remote`。

> 注意：`wrangler d1 migrations apply` 會把 `migrations/` 資料夾裡**所有** `.sql` 檔都當成遷移檔套用，
> 包括 `seed_demo.sql`（假資料）。所以目前請用上面的 `d1 execute --file` 一個一個套，
> **不要對正式資料庫跑 `migrations apply`**，以免把假資料灌進正式環境。

## 4. 在本機跑起來（用假帳號試）

1. 在專案根目錄建一個檔案 `.dev.vars`（已在 `.gitignore` 排除，不會被提交），內容只有一行：

   ```
   DEV_AUTH="1"
   ```

2. 啟動：

   ```bash
   npx wrangler dev
   ```

3. 打開瀏覽器到 `http://localhost:8787`。
4. 畫面上方會出現黃色的「本機開發模式」列，選一個假帳號，按「套用」：
   - `customer1@example.com`、`customer2@example.com`：客戶，只看得到自己的 2 個專案
   - `staff1@example.com`：船廠人員，看得到全部專案
   - `admin1@example.com`：管理者，看得到全部專案，也看得到「法規維護」

也可以直接用指令試 API：

```bash
curl -H "X-Dev-User: customer1@example.com" http://localhost:8787/api/me
curl -H "X-Dev-User: customer1@example.com" http://localhost:8787/api/projects
curl -H "X-Dev-User: customer1@example.com" http://localhost:8787/api/projects/3   # 別人的專案 → 403
```

### DEV_AUTH 的安全規則（很重要）

- `X-Dev-User` 這個標頭**只有**在 `DEV_AUTH` 剛好等於 `"1"` 時後端才會認。
- `DEV_AUTH` 只能放在本機 `.dev.vars`。**絕對不要**寫進 `wrangler.jsonc` 的 `vars`，
  也不要用 `wrangler secret put` 設到雲端。設了等於任何人都能冒充任何帳號。

## 5. 設定 Cloudflare Access（正式登入）

Cloudflare Access 會擋在網站前面：沒通過登入的人連網頁都進不來。
通過後，Access 會在每個請求加上標頭 `Cf-Access-Authenticated-User-Email`，後端用它知道「你是誰」。

1. 到 Cloudflare 後台 → **Zero Trust** → **Access** → **Applications** → **Add an application** → 選 **Self-hosted**。
2. 網域填這個網站的網址（例如 `<名稱>.<你的子網域>.workers.dev`，或你自己的網域）。
   **整個網站都要保護**，不要只保護部分路徑。
3. 新增一條 **Policy（規則）**：Action 選 **Allow**，條件選 **Emails**，填上要放行的 email
   （或 Emails ending in 填船廠的網域）。
4. 登入方式可以先用預設的 **One-time PIN**（寄一次性密碼到信箱）。
5. 存檔後，用無痕視窗打開網站，應該會先看到 Cloudflare 的登入畫面。

### 讓登入的人有角色

通過 Access 只代表「信箱是真的」。系統還要在 `users` 資料表找到這個 email，才知道他是客戶、船廠人員還是管理者；
找不到就回 403（沒有權限）。

新增使用者（範例，email 換成真的人；**不要**把真的客戶資料提交進專案）：

```bash
npx wrangler d1 execute yacht-order --remote --command "INSERT INTO users (email, name, role) VALUES ('someone@example.com', '某某', 'customer')"
```

### 要特別注意

- 後端相信 `Cf-Access-Authenticated-User-Email` 這個標頭。如果網站有任何一個網址**沒有**被 Access 保護，
  別人就可能自己偽造這個標頭。所以一定要確認所有網址（包括 `workers.dev` 網址和預覽網址）都在 Access 後面。
- 正式環境不要設定 `DEV_AUTH`。
