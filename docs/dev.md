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
| 假資料 | `seeds/seed_demo.sql` | 示範用的假帳號和假專案（@example.com）。放在 `migrations/` 外面，避免被當成遷移檔套用 |
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
npx wrangler d1 execute yacht-order --local --file=seeds/seed_demo.sql
```

雲端（測試環境）：把上面的 `--local` 換成 `--remote`。

> 注意：假資料 `seeds/seed_demo.sql` 已經搬出 `migrations/` 資料夾，
> 所以 `wrangler d1 migrations apply` 只會套用資料表結構，不會順便灌假資料。
> **正式資料庫不要執行 `seeds/seed_demo.sql`**，假資料只給本機或測試環境用。

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
通過後，Access 會在每個請求附上一張「登入憑證」（JWT，一段有數位簽章、偽造不了的文字），
放在標頭 `Cf-Access-Jwt-Assertion` 和 cookie `CF_Authorization`。
後端會先檢查這張憑證是真的、沒過期、是發給這個網站的，才從裡面拿 email 知道「你是誰」。

1. 到 Cloudflare 後台 → **Zero Trust** → **Access** → **Applications** → **Add an application** → 選 **Self-hosted**。
2. 網域填這個網站的網址（你自己的網域，例如 `yacht.你的網域.com`）。
   `wrangler.jsonc` 已經關掉 `workers.dev` 網址和預覽網址（`workers_dev: false`、`preview_urls: false`），
   所以要先在 Cloudflare 後台幫 Worker `yacht-order` 加一個自訂網域（Custom Domain）。
   **整個網站都要保護**，不要只保護部分路徑。
3. 新增一條 **Policy（規則）**：Action 選 **Allow**，條件選 **Emails**，填上要放行的 email
   （或 Emails ending in 填船廠的網域）。
4. 登入方式可以先用預設的 **One-time PIN**（寄一次性密碼到信箱）。
5. 存檔後，用無痕視窗打開網站，應該會先看到 Cloudflare 的登入畫面。

### 設定 ACCESS_TEAM_DOMAIN、ACCESS_AUD（後端驗證登入憑證要用）

後端要知道兩件事，才能檢查登入憑證：「是哪個 Access 團隊發的」和「是發給哪個網站的」。
這兩個值**不是金鑰、不是密碼**，可以直接寫在 `wrangler.jsonc`。
沒設定（或還是 `REPLACE` 開頭的佔位字串）時，正式網站所有 API 都會回 403，誰都進不來——這是故意的，比較安全。

1. **找團隊網域（ACCESS_TEAM_DOMAIN）**：
   Cloudflare 後台 → **Zero Trust** → **Settings** → **Custom Pages**（或 **Team name and domain**），
   會看到像 `your-team.cloudflareaccess.com` 的網址。只要這段網域，**不要**加 `https://`。
2. **找 AUD 標籤（ACCESS_AUD）**：
   **Zero Trust** → **Access** → **Applications** → 點剛剛建的應用程式 → **Overview**（概覽），
   找到 **Application Audience (AUD) Tag**，是一長串英文數字，按旁邊的複製。
3. 打開 `wrangler.jsonc`，在 `vars` 裡把佔位字串換掉：

   ```jsonc
   "vars": {
     "ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
     "ACCESS_AUD": "貼上剛剛複製的 AUD 標籤"
   }
   ```

4. 重新上線（deploy）後生效。
5. 檢查：用無痕視窗登入網站，看得到自己的名字和角色就成功；
   直接用 `curl` 打 API（沒有登入憑證）應該被導到 Cloudflare 登入頁，或回 403。

> 本機開發（`.dev.vars` 有 `DEV_AUTH="1"`）時不會檢查登入憑證，這兩個值不用設也能跑。

### 讓登入的人有角色

通過 Access 只代表「信箱是真的」。系統還要在 `users` 資料表找到這個 email，才知道他是客戶、船廠人員還是管理者；
找不到就回 403（沒有權限）。

新增使用者（範例，email 換成真的人；**不要**把真的客戶資料提交進專案）：

```bash
npx wrangler d1 execute yacht-order --remote --command "INSERT INTO users (email, name, role) VALUES ('someone@example.com', '某某', 'customer')"
```

### 要特別注意

- 後端**不再**直接相信 `Cf-Access-Authenticated-User-Email` 標頭，只相信驗證過簽章的登入憑證，
  所以就算有人自己加這個標頭也冒充不了別人。
- 仍然建議整個網站都放在 Access 後面；`workers.dev` 網址和預覽網址已在 `wrangler.jsonc` 關掉。
- 正式環境不要設定 `DEV_AUTH`。設了等於關掉登入憑證檢查。

## 6. 示範模式（沒有後端也能看畫面）

給成品頁預覽或展示用：

- 網址加上 `?demo=1`（例如 `http://localhost:8787/?demo=1`），或
- 打開 `public/index.html` 時連不到後端，

畫面會進入「示範模式」：上方有明顯的橘色列寫著「示範模式：假資料、不會存檔」，
可以切換假角色（客戶1、客戶2、船廠人員、管理者）看不同角色看到的畫面。

- 假資料寫在前端，內容和 `seeds/seed_demo.sql` 一樣。改了其中一邊，記得另一邊也要改。
- 示範模式**完全不送請求給後端**，也不影響後端權限；它只是畫面展示。
