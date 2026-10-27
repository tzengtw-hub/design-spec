// 遊艇訂製網站：Cloudflare Worker 後端（SDD-001，技術見 ADR-0002）
// 純 JavaScript（ES module），不用打包工具、不用 npm 套件。
//
// 請求怎麼走：
//   /api/*  → 先進這支 Worker（wrangler.jsonc 的 assets.run_worker_first）
//   其他    → 直接回 public/ 底下的靜態檔（前端畫面）
//
// 權限規則（重要）：每一支 API 都要先經過 authenticate()，拿到「登入者 + 角色」才可以讀資料。
// 前端藏按鈕只是畫面，真正的擋在這裡。
// 專案底下的 API（需求、規格書、意見）還要先經過 loadProject()：客戶只能碰自己的專案。
//
// API 一覽：
//   GET  /api/me、GET /api/projects、GET /api/projects/:id
//   GET/PUT  /api/projects/:id/requirements          需求暫存（畫面 3）
//   POST     /api/projects/:id/spec/generate         由需求產生新版規格書
//   GET/POST /api/projects/:id/spec                  最新版／編輯後存成新版
//   GET      /api/projects/:id/spec/versions[/:v]    版本列表／某一版
//   POST     /api/projects/:id/spec/restore/:v       舊版複製成新版
//   GET/POST /api/projects/:id/comments              意見（新增只限 staff／admin）
//   GET      /api/projects/:id/rule-match            法規對照（畫面 6，staff／admin）
//   GET      /api/rules?q=&category=&status=         法規查詢（畫面 5，staff／admin；status 只限 admin）
//   POST     /api/rules                              新增條文（草稿，admin）
//   GET/PUT  /api/rules/:id                          看一筆（staff 只看已發佈）／編輯（admin）
//   POST     /api/rules/:id/publish、/disable        發佈、停用（admin）
//   GET      /api/rules/:id/revisions                修改紀錄（admin）
// 寫入請求一律要 Content-Type: application/json、內容 64KB 以內。

const ROLES = ["customer", "staff", "admin"];

// ---------- 小工具 ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function error(status, message) {
  return json({ error: message }, status);
}

// ---------- Cloudflare Access 登入憑證（JWT）驗證 ----------
//
// Access 登入成功後，每個請求都會帶一張「登入憑證」（JWT，一段有數位簽章的文字）：
//   標頭 Cf-Access-Jwt-Assertion，或 cookie CF_Authorization。
// 我們用 Cloudflare 公開的公鑰（JWKS）檢查簽章是真的，再檢查：
//   aud（這張憑證是發給「這個網站」的）、exp（還沒過期）、iss（是我們的 Access 團隊發的）。
// 全部通過才相信裡面的 email。只用瀏覽器內建的 Web Crypto（crypto.subtle），不用套件。

const JWKS_TTL_MS = 60 * 60 * 1000;      // 公鑰快取 1 小時
const JWKS_MIN_REFETCH_MS = 60 * 1000;   // 遇到不認得的 kid，最快 60 秒才重抓一次
const jwksCache = new Map();             // teamDomain -> { keys: Map(kid -> CryptoKey), fetchedAt }

// 把 ACCESS_TEAM_DOMAIN 整理成「只有網域」：去掉 https:// 和結尾斜線。
// 一律轉小寫。沒設定或還是佔位字串（以 REPLACE 開頭）都當成沒設定。
function normalizeTeamDomain(value) {
  const v = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  if (!v || /^REPLACE/i.test(v)) return "";
  return v;
}

function normalizeAud(value) {
  const v = String(value || "").trim();
  if (!v || /^REPLACE/i.test(v)) return "";
  return v;
}

function base64UrlToBytes(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlToJson(s) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(s)));
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return "";
}

async function fetchJwks(teamDomain) {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`JWKS 取得失敗：HTTP ${res.status}`);
  const data = await res.json();
  const keys = new Map();
  for (const jwk of (data && Array.isArray(data.keys)) ? data.keys : []) {
    if (!jwk || jwk.kty !== "RSA" || !jwk.kid) continue;
    if (jwk.alg && jwk.alg !== "RS256") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );
      keys.set(jwk.kid, key);
    } catch (e) {
      console.error("略過無法匯入的公鑰", jwk.kid);
    }
  }
  const entry = { keys, fetchedAt: Date.now() };
  jwksCache.set(teamDomain, entry);
  return entry;
}

async function getVerifyKey(teamDomain, kid) {
  let entry = jwksCache.get(teamDomain);
  const now = Date.now();
  if (!entry || now - entry.fetchedAt > JWKS_TTL_MS) {
    entry = await fetchJwks(teamDomain);
  } else if (!entry.keys.has(kid) && now - entry.fetchedAt > JWKS_MIN_REFETCH_MS) {
    // Cloudflare 會輪換金鑰：不認得的 kid 就重抓一次（有最短間隔，避免被灌請求）
    entry = await fetchJwks(teamDomain);
  }
  return entry.keys.get(kid) || null;
}

// 驗證成功回 email（小寫）；任何一項不通過都回 ""。
async function verifyAccessJwt(token, teamDomain, aud) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts.some(p => !p)) return "";

  let header, payload;
  try {
    header = base64UrlToJson(parts[0]);
    payload = base64UrlToJson(parts[1]);
  } catch (e) {
    return "";
  }

  if (!header || header.alg !== "RS256" || !header.kid) return "";

  const key = await getVerifyKey(teamDomain, header.kid);
  if (!key) return "";

  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1])
    );
  } catch (e) {
    ok = false;
  }
  if (!ok) return "";

  const nowSec = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return "";
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) return "";
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) return "";
  if (payload.iss !== `https://${teamDomain}`) return "";

  return typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
}

// ---------- 登入（共用，每支 API 都要經過） ----------
//
// 正式環境：讀 Access 的登入憑證（Cf-Access-Jwt-Assertion 標頭，或 CF_Authorization cookie），
//          用 verifyAccessJwt() 驗過簽章、aud、exp、iss 才相信裡面的 email。
//          不再直接相信 Cf-Access-Authenticated-User-Email 標頭（它可以被偽造）。
//          ACCESS_TEAM_DOMAIN 或 ACCESS_AUD 沒設定（或還是佔位字串）時，一律 403。
// 本機開發：只有環境變數 DEV_AUTH 剛好等於 "1" 時，維持原本做法：
//          接受 Cf-Access-Authenticated-User-Email 或 X-Dev-User 標頭，不驗憑證。
//          DEV_AUTH 只能放在本機的 .dev.vars，絕對不可以設在正式環境。
//
// 回傳：{ user: { email, name, role } } 或 { response: <錯誤回應> }
export async function authenticate(request, env) {
  let email = "";

  // DEV_AUTH="1" 而且請求真的是打到本機（localhost／127.0.0.1／[::1]）才算本機開發；
  // 否則一律當正式模式，避免 DEV_AUTH 不小心被設到正式環境時被繞過登入。
  let reqHost = "";
  try { reqHost = new URL(request.url).hostname.toLowerCase(); } catch (e) { reqHost = ""; }
  const isLocalRequest = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(reqHost);

  if (env.DEV_AUTH === "1" && isLocalRequest) {
    // 本機開發模式（維持原狀）
    email = request.headers.get("Cf-Access-Authenticated-User-Email") ||
            request.headers.get("X-Dev-User") || "";
  } else {
    // 正式模式：一定要驗證登入憑證
    const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
    const aud = normalizeAud(env.ACCESS_AUD);
    if (!teamDomain || !aud) {
      return { response: error(403, "登入設定不完整（ACCESS_TEAM_DOMAIN 或 ACCESS_AUD 未設定），暫時不能使用。") };
    }

    const token = request.headers.get("Cf-Access-Jwt-Assertion") || getCookie(request, "CF_Authorization");
    if (!token) {
      return { response: error(403, "沒有登入資訊，請透過 Cloudflare Access 登入。") };
    }

    try {
      email = await verifyAccessJwt(token, teamDomain, aud);
    } catch (e) {
      // 例如抓不到公鑰：不放行
      console.error(e);
      email = "";
    }
    if (!email) {
      return { response: error(403, "登入資訊無效或已過期，請重新透過 Cloudflare Access 登入。") };
    }
  }

  email = String(email || "").trim().toLowerCase();
  if (!email) {
    return { response: error(403, "沒有登入資訊，請透過 Cloudflare Access 登入。") };
  }

  if (!env.DB) {
    return { response: error(500, "後端沒有接上資料庫（DB 綁定不存在）。") };
  }

  const user = await env.DB
    .prepare("SELECT email, name, role FROM users WHERE lower(email) = ?1")
    .bind(email)
    .first();

  if (!user || !ROLES.includes(user.role)) {
    return { response: error(403, "這個帳號沒有使用權限，請聯絡船廠管理者。") };
  }

  return { user };
}

function isStaffOrAdmin(user) {
  return user.role === "staff" || user.role === "admin";
}

// ---------- 專案存取權（每支專案相關 API 都先經過這裡） ----------

// 客戶只能碰自己的專案；staff／admin 可碰全部
function canAccessProject(user, project) {
  if (isStaffOrAdmin(user)) return true;
  return user.role === "customer" &&
    String(project.owner_email || "").toLowerCase() === String(user.email || "").toLowerCase();
}

// 需求表單只有「該專案客戶本人、staff、admin」可寫
function canWriteRequirements(user, project) {
  return canAccessProject(user, project);
}

// 規格書（產生、編輯、還原）：有專案存取權的人都可以（SDD 畫面 4：全部可預覽與編輯）
function canWriteSpec(user, project) {
  return canAccessProject(user, project);
}

// 意見：只有船廠人員（staff）和管理者（admin）可新增（SDD 功能 1：船廠人員加註）
function canAddComment(user, project) {
  return isStaffOrAdmin(user) && canAccessProject(user, project);
}

// 回 { project } 或 { response: <錯誤回應> }
async function loadProject(user, env, id) {
  const project = await env.DB
    .prepare("SELECT id, name, boat_type, status, owner_email, created_at FROM projects WHERE id = ?1")
    .bind(id)
    .first();

  if (!project) {
    // 客戶問不存在的專案也回 403，避免從 404／403 的差別猜出別人有哪些專案編號。
    if (!isStaffOrAdmin(user)) return { response: error(403, "你沒有權限看這個專案。") };
    return { response: error(404, "找不到這個專案。") };
  }
  if (!canAccessProject(user, project)) {
    return { response: error(403, "你沒有權限看這個專案。") };
  }
  return { project };
}

// ---------- 讀請求內容（JSON），限制大小 ----------

const MAX_BODY_BYTES = 64 * 1024;

// 回 { body } 或 { response: <錯誤回應> }
async function readJsonBody(request) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.startsWith("application/json")) {
    return { response: error(415, "請用 JSON 格式送出（Content-Type: application/json）。") };
  }
  const len = request.headers.get("content-length");
  if (len && Number(len) > MAX_BODY_BYTES) {
    return { response: error(413, "送出的資料太大（上限 64KB）。") };
  }
  if (!request.body) {
    return { response: error(400, "沒有收到資料。") };
  }

  // 邊讀邊算大小，超過上限就停（不相信 content-length）
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      try { await reader.cancel(); } catch (e) { /* 忽略 */ }
      return { response: error(413, "送出的資料太大（上限 64KB）。") };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    return { response: error(400, "資料不是正確的 UTF-8 文字。") };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return { response: error(400, "資料格式錯誤（不是正確的 JSON）。") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { response: error(400, "資料格式錯誤（必須是 JSON 物件）。") };
  }
  return { body };
}

// ---------- 需求表單欄位（SDD-001 附錄 A，暫用假範例） ----------
// 重要：public/index.html 有一份一模一樣的 REQ_FIELDS 與 validateRequirement()（示範模式和前端提示用）。
//       改了這邊，記得也改那邊，兩邊規則要一致。

// step 是表單第幾步（1 基本、2 用途、3 動力、4 艙室、5 設備、6 預算與交期）
const REQ_FIELDS = [
  { key: "project_name",  step: 1, label: "專案名稱",           type: "text",    required: true,  maxLength: 100 },
  { key: "boat_type",     step: 1, label: "船型",               type: "select",  required: true,  options: ["機動遊艇", "帆船", "雙體船"] },
  { key: "loa",           step: 1, label: "船長 LOA（公尺）",   type: "number",  required: true,  min: 12, max: 60 },
  { key: "beam",          step: 1, label: "船寬（公尺）",       type: "number",  required: true,  min: 3, max: 12 },
  { key: "usage",         step: 2, label: "用途",               type: "select",  required: true,  options: ["私人", "商業包租"] },
  { key: "area",          step: 2, label: "航區",               type: "select",  required: true,  options: ["近岸", "沿海", "遠洋"] },
  { key: "passengers",    step: 2, label: "乘客人數",           type: "integer", required: true,  min: 0, max: 36 },
  { key: "crew",          step: 2, label: "船員人數",           type: "integer", required: true,  min: 0, max: 20 },
  { key: "propulsion",    step: 3, label: "動力型式",           type: "select",  required: true,  options: ["柴油內燃機", "油電混合", "純電"] },
  { key: "max_speed",     step: 3, label: "最高航速（節）",     type: "number",  required: false, min: 0 },
  { key: "cruise_speed",  step: 3, label: "巡航航速（節）",     type: "number",  required: false, min: 0 },
  { key: "cabins",        step: 4, label: "客艙數",             type: "integer", required: true,  min: 0, max: 10 },
  { key: "crew_cabins",   step: 4, label: "船員艙數",           type: "integer", required: false, min: 0 },
  { key: "bathrooms",     step: 4, label: "衛浴數",             type: "integer", required: false, min: 0 },
  { key: "equipment",     step: 5, label: "設備選項",           type: "multi",   required: false, options: ["減搖鰭", "發電機", "造水機", "空調", "甲板吊車", "衛星通訊"] },
  { key: "budget",        step: 6, label: "預算（新台幣萬元）", type: "number",  required: false, min: 0 },
  { key: "delivery_date", step: 6, label: "希望交船日期",       type: "date",    required: false },
  { key: "other_notes",   step: 6, label: "其他需求",           type: "longtext", required: false, maxLength: 2000 },
];

const REQ_FIELD_KEYS = REQ_FIELDS.map(f => f.key);

function isEmptyValue(f, raw) {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === "string" && raw.trim() === "") return true;
  if (f.type === "multi" && Array.isArray(raw) && raw.length === 0) return true;
  return false;
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// 驗證一個欄位：回 { value } 或 { error }
function validateField(f, raw) {
  const L = "「" + f.label + "」";
  switch (f.type) {
    case "text":
    case "longtext": {
      if (typeof raw !== "string") return { error: L + "格式不正確。" };
      const v = raw.trim();
      if (f.maxLength && v.length > f.maxLength) return { error: L + "最多 " + f.maxLength + " 個字。" };
      return { value: v };
    }
    case "select": {
      if (typeof raw !== "string" || !f.options.includes(raw)) {
        return { error: L + "請從選項中選擇：" + f.options.join("、") + "。" };
      }
      return { value: raw };
    }
    case "number":
    case "integer": {
      let n;
      if (typeof raw === "number") n = raw;
      else if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())) n = Number(raw.trim());
      else return { error: L + "必須是數字。" };
      if (!Number.isFinite(n)) return { error: L + "必須是數字。" };
      if (f.type === "integer" && !Number.isInteger(n)) return { error: L + "必須是整數。" };
      const hasMin = typeof f.min === "number", hasMax = typeof f.max === "number";
      if (hasMin && hasMax && (n < f.min || n > f.max)) return { error: L + "必須介於 " + f.min + " 到 " + f.max + "。" };
      if (hasMin && n < f.min) return { error: L + "不能小於 " + f.min + "。" };
      if (hasMax && n > f.max) return { error: L + "不能大於 " + f.max + "。" };
      return { value: n };
    }
    case "multi": {
      if (!Array.isArray(raw)) return { error: L + "格式不正確。" };
      for (const item of raw) {
        if (typeof item !== "string" || !f.options.includes(item)) {
          return { error: L + "只能選：" + f.options.join("、") + "。" };
        }
      }
      // 去重複，並照選項順序排好
      return { value: f.options.filter(o => raw.includes(o)) };
    }
    case "date": {
      if (typeof raw !== "string" || !isValidDate(raw.trim())) return { error: L + "日期格式不正確（例如 2027-06-30）。" };
      return { value: raw.trim() };
    }
    default:
      return { error: L + "格式不正確。" };
  }
}

// requireAll=true：必填一定要有（產生規格書、儲存規格書）
// requireAll=false：暫存用，可以缺必填，但填了的都要格式正確
// 回 { data, errors, missing }：errors 是 { 欄位key: 中文錯誤 }；missing 是還沒填的必填欄位 key
function validateRequirement(input, requireAll) {
  const errors = {};
  const missing = [];
  const data = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { data, errors: { _form: "需求資料格式不正確。" }, missing: REQ_FIELDS.filter(f => f.required).map(f => f.key) };
  }
  for (const f of REQ_FIELDS) {
    const raw = input[f.key];
    if (isEmptyValue(f, raw)) {
      if (f.required) {
        missing.push(f.key);
        if (requireAll) errors[f.key] = "請填寫「" + f.label + "」。";
      }
      continue;
    }
    const r = validateField(f, raw);
    if (r.error) errors[f.key] = r.error;
    else data[f.key] = r.value;
  }
  // 沒有在欄位清單裡的 key 一律丟掉，不存
  return { data, errors, missing };
}

function validationError(errors) {
  return json({ error: "資料有誤，請檢查標示的欄位。", fields: errors }, 400);
}

function parseJsonColumn(text) {
  try { return JSON.parse(text); } catch (e) { return {}; }
}

// ---------- API ----------

// GET /api/me：回自己的 email、名字、角色
async function getMe(user) {
  return json({ email: user.email, name: user.name, role: user.role });
}

// GET /api/projects：客戶只回自己的；staff／admin 回全部
async function listProjects(user, env) {
  const cols = "id, name, boat_type, status, owner_email, created_at";
  let stmt;
  if (isStaffOrAdmin(user)) {
    stmt = env.DB.prepare(`SELECT ${cols} FROM projects ORDER BY id`);
  } else {
    stmt = env.DB
      .prepare(`SELECT ${cols} FROM projects WHERE lower(owner_email) = ?1 ORDER BY id`)
      .bind(user.email.toLowerCase());
  }
  const { results } = await stmt.all();
  return json({ projects: results || [] });
}

// GET /api/projects/:id：客戶讀別人的專案回 403（存取權在 loadProject 檢查）
async function getProject(project) {
  return json({ project });
}

// ---------- 需求表單（畫面 3） ----------

// GET /api/projects/:id/requirements
async function getRequirements(env, project) {
  const row = await env.DB
    .prepare("SELECT data, updated_by, updated_at FROM requirement_drafts WHERE project_id = ?1")
    .bind(project.id)
    .first();
  if (!row) return json({ draft: null });
  return json({ draft: { data: parseJsonColumn(row.data), updated_by: row.updated_by, updated_at: row.updated_at } });
}

// PUT /api/projects/:id/requirements  body: { data: {...} }
// 暫存：可以缺必填（回 missing 告訴前端還缺哪些），但填了的欄位格式、範圍、選項都要正確
async function putRequirements(request, user, env, project) {
  if (!canWriteRequirements(user, project)) return error(403, "你沒有權限修改這個專案的需求。");
  const rb = await readJsonBody(request);
  if (rb.response) return rb.response;

  const { data, errors, missing } = validateRequirement(rb.body.data, false);
  if (Object.keys(errors).length) return validationError(errors);

  const dataText = JSON.stringify(data);
  const [up] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO requirement_drafts (project_id, data, updated_by, updated_at) VALUES (?1, ?2, ?3, datetime('now')) " +
      "ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at " +
      "RETURNING updated_at"
    ).bind(project.id, dataText, user.email),
    env.DB.prepare("INSERT INTO audit_log (actor_email, action, detail) VALUES (?1, ?2, ?3)")
      .bind(user.email, "requirements_save", "專案 " + project.id + " 暫存需求"),
  ]);
  const updatedAt = up && up.results && up.results[0] ? up.results[0].updated_at : null;
  return json({ draft: { data, updated_by: user.email, updated_at: updatedAt }, missing });
}

// ---------- 規格書（畫面 4） ----------

function specRow(row) {
  return {
    version: row.version,
    data: parseJsonColumn(row.data),
    note: row.note,
    created_by: row.created_by,
    created_by_name: row.created_by_name || null,
    created_at: row.created_at,
  };
}

// 新增一個規格書版本（永遠是新的一列，版本號 = 目前最大 + 1），同時記 audit_log。
// 兩個 INSERT 用 batch 送出，D1 會當成同一個交易（全部成功或全部失敗）。
async function insertSpecVersion(env, project, user, dataObj, note, action) {
  const dataText = JSON.stringify(dataObj);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [ins] = await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO spec_versions (project_id, version, data, created_by, note) " +
          "SELECT ?1, COALESCE(MAX(version), 0) + 1, ?2, ?3, ?4 FROM spec_versions WHERE project_id = ?1 " +
          "RETURNING version, created_at"
        ).bind(project.id, dataText, user.email, note),
        env.DB.prepare(
          "INSERT INTO audit_log (actor_email, action, detail) " +
          "SELECT ?1, ?2, '專案 ' || ?3 || ' 規格書 v' || MAX(version) || '（' || ?4 || '）' FROM spec_versions WHERE project_id = ?3"
        ).bind(user.email, action, project.id, note),
      ]);
      const row = ins && ins.results && ins.results[0];
      return {
        version: row ? row.version : null,
        data: dataObj,
        note,
        created_by: user.email,
        created_by_name: user.name || null,
        created_at: row ? row.created_at : null,
      };
    } catch (e) {
      // 兩個人同時儲存撞到同一個版本號：重試（UNIQUE(project_id, version) 保證不會覆蓋）
      if (attempt < 2 && /UNIQUE/i.test(String(e && e.message))) continue;
      throw e;
    }
  }
  throw new Error("規格書版本儲存失敗");
}

const SPEC_COLS =
  "s.version, s.data, s.note, s.created_by, s.created_at, u.name AS created_by_name";

// GET /api/projects/:id/spec：最新版本（還沒有就回 null）
async function getLatestSpec(env, project) {
  const row = await env.DB
    .prepare(`SELECT ${SPEC_COLS} FROM spec_versions s LEFT JOIN users u ON u.email = s.created_by
              WHERE s.project_id = ?1 ORDER BY s.version DESC LIMIT 1`)
    .bind(project.id)
    .first();
  return json({ spec: row ? specRow(row) : null });
}

// GET /api/projects/:id/spec/versions：版本列表（新到舊，不含內容）
async function listSpecVersions(env, project) {
  const { results } = await env.DB
    .prepare(`SELECT s.version, s.note, s.created_by, s.created_at, u.name AS created_by_name
              FROM spec_versions s LEFT JOIN users u ON u.email = s.created_by
              WHERE s.project_id = ?1 ORDER BY s.version DESC`)
    .bind(project.id)
    .all();
  return json({ versions: results || [] });
}

// GET /api/projects/:id/spec/versions/:v
async function getSpecVersion(env, project, v) {
  const row = await env.DB
    .prepare(`SELECT ${SPEC_COLS} FROM spec_versions s LEFT JOIN users u ON u.email = s.created_by
              WHERE s.project_id = ?1 AND s.version = ?2`)
    .bind(project.id, v)
    .first();
  if (!row) return error(404, "找不到這個版本。");
  return json({ spec: specRow(row) });
}

// POST /api/projects/:id/spec/generate：把目前的需求整理成新版本（必填都齊才可）
async function generateSpec(request, user, env, project) {
  if (!canWriteSpec(user, project)) return error(403, "你沒有權限產生這個專案的規格書。");
  const rb = await readJsonBody(request);   // 內容不用，但仍要求 JSON（防跨站送出）
  if (rb.response) return rb.response;

  const draft = await env.DB
    .prepare("SELECT data FROM requirement_drafts WHERE project_id = ?1")
    .bind(project.id)
    .first();
  if (!draft) return error(400, "還沒有填寫需求，請先填寫並暫存需求表單。");

  const { data, errors } = validateRequirement(parseJsonColumn(draft.data), true);
  if (Object.keys(errors).length) return validationError(errors);

  const spec = await insertSpecVersion(env, project, user, data, "由需求產生", "spec_generate");
  return json({ spec }, 201);
}

// POST /api/projects/:id/spec  body: { data: {...} }：編輯後儲存成新版本
async function saveSpec(request, user, env, project) {
  if (!canWriteSpec(user, project)) return error(403, "你沒有權限修改這個專案的規格書。");
  const rb = await readJsonBody(request);
  if (rb.response) return rb.response;

  const { data, errors } = validateRequirement(rb.body.data, true);
  if (Object.keys(errors).length) return validationError(errors);

  const spec = await insertSpecVersion(env, project, user, data, "編輯後儲存", "spec_save");
  return json({ spec }, 201);
}

// POST /api/projects/:id/spec/restore/:v：把舊版內容複製成新版本（不刪舊版）
async function restoreSpec(request, user, env, project, v) {
  if (!canWriteSpec(user, project)) return error(403, "你沒有權限修改這個專案的規格書。");
  const rb = await readJsonBody(request);
  if (rb.response) return rb.response;

  const old = await env.DB
    .prepare("SELECT data FROM spec_versions WHERE project_id = ?1 AND version = ?2")
    .bind(project.id, v)
    .first();
  if (!old) return error(404, "找不到這個版本。");

  const spec = await insertSpecVersion(env, project, user, parseJsonColumn(old.data), "還原自 v" + v, "spec_restore");
  return json({ spec }, 201);
}

// ---------- 意見 ----------

const COMMENT_TYPES = ["customer_request", "yard_suggestion"];
const COMMENT_MAX = 2000;

// GET /api/projects/:id/comments
async function listComments(env, project) {
  const { results } = await env.DB
    .prepare(`SELECT c.id, c.spec_version, c.field_key, c.type, c.content, c.author_email, u.name AS author_name, c.created_at
              FROM spec_comments c LEFT JOIN users u ON u.email = c.author_email
              WHERE c.project_id = ?1 ORDER BY c.created_at, c.id`)
    .bind(project.id)
    .all();
  return json({ comments: results || [] });
}

// POST /api/projects/:id/comments  body: { spec_version, field_key?, type, content }
async function addComment(request, user, env, project) {
  if (!canAddComment(user, project)) return error(403, "只有船廠人員可以新增意見。");
  const rb = await readJsonBody(request);
  if (rb.response) return rb.response;
  const b = rb.body;

  const errors = {};
  // 只接受真正的整數（不接受字串 "1"、1.5、true 等），前端示範模式同樣規則
  const ver = b.spec_version;
  if (typeof ver !== "number" || !Number.isInteger(ver) || ver < 1) errors.spec_version = "請指定規格書版本（必須是 1 以上的整數）。";
  let fieldKey = b.field_key;
  if (fieldKey === undefined || fieldKey === null || fieldKey === "") fieldKey = null;
  else if (typeof fieldKey !== "string" || !REQ_FIELD_KEYS.includes(fieldKey)) errors.field_key = "欄位不正確。";
  if (!COMMENT_TYPES.includes(b.type)) errors.type = "類型必須是「客戶需求」或「船廠建議」。";
  const content = typeof b.content === "string" ? b.content.trim() : "";
  if (!content) errors.content = "請填寫意見內容。";
  else if (content.length > COMMENT_MAX) errors.content = "意見最多 " + COMMENT_MAX + " 個字。";
  if (Object.keys(errors).length) return validationError(errors);

  const exists = await env.DB
    .prepare("SELECT 1 AS ok FROM spec_versions WHERE project_id = ?1 AND version = ?2")
    .bind(project.id, ver)
    .first();
  if (!exists) return validationError({ spec_version: "找不到這個規格書版本。" });

  const [ins] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO spec_comments (project_id, spec_version, field_key, type, content, author_email) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id, created_at"
    ).bind(project.id, ver, fieldKey, b.type, content, user.email),
    env.DB.prepare("INSERT INTO audit_log (actor_email, action, detail) VALUES (?1, ?2, ?3)")
      .bind(user.email, "comment_add", "專案 " + project.id + " 規格書 v" + ver + " 新增意見（" + b.type + "）"),
  ]);
  const row = ins && ins.results && ins.results[0];
  return json({
    comment: {
      id: row ? row.id : null,
      spec_version: ver,
      field_key: fieldKey,
      type: b.type,
      content,
      author_email: user.email,
      author_name: user.name || null,
      created_at: row ? row.created_at : null,
    },
  }, 201);
}

// ---------- 法規摘要（SDD-001 功能 2、畫面 5、6、8、驗收 4.2） ----------
// 重要：public/index.html 有一份一模一樣的 RULE_* 常數、normalizeConditions()、validateRule()、
//       rulePublishMissing()、matchParamsFrom()、matchRule()、matchRules()（示範模式和前端提示用）。
//       改了這邊，記得也改那邊，兩邊規則要一致。
// 權限：查詢、對照只限 staff／admin；維護（新增、編輯、發佈、停用、修改紀錄、看草稿與停用）只限 admin。
// 系統只列出「可能相關」的條文，不判定合規（SDD 不做的事）。

const RULE_CATEGORIES = ["結構", "穩度", "消防", "機械", "電氣"];
const RULE_STATUSES = ["draft", "published", "disabled"];
const RULE_TEXT_FIELDS = [
  { key: "article_no",   label: "條文編號", required: false, maxLength: 50 },
  { key: "title",        label: "標題",     required: true,  maxLength: 200 },
  { key: "summary",      label: "重點說明", required: false, maxLength: 2000 },
  { key: "rule_version", label: "規則版本", required: false, maxLength: 50 },
];
// 發佈前一定要有的三項（驗收 4.2 第二條）
const RULE_PUBLISH_REQUIRED = [
  { key: "article_no",     label: "條文編號" },
  { key: "rule_version",   label: "規則版本" },
  { key: "effective_date", label: "生效日期" },
];
// 適用條件裡的「多選」項目：key 是條件名稱，field 是需求表單欄位（選項沿用 REQ_FIELDS，與附錄 A 一致）
const RULE_COND_LISTS = [
  { key: "boat_types",  field: "boat_type",  label: "船型" },
  { key: "areas",       field: "area",       label: "航區" },
  { key: "usages",      field: "usage",      label: "用途" },
  { key: "propulsions", field: "propulsion", label: "動力" },
];
const RULE_LOA_LIMIT_MIN = 0;
const RULE_LOA_LIMIT_MAX = 200;
const RULE_QUERY_MAX = 100;
// 對照時從規格書拿的參數
const MATCH_PARAM_KEYS = ["loa", "boat_type", "area", "usage", "propulsion"];

function reqField(key) {
  return REQ_FIELDS.find(f => f.key === key);
}

function isBlank(raw) {
  return raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
}

// 適用條件：回 { value, errors }。value 只留有填的項目（沒填＝不限）；不認得的 key 一律丟掉。
function normalizeConditions(raw) {
  const errors = {};
  const value = {};
  if (raw === undefined || raw === null) return { value, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) return { value, errors: { conditions: "適用條件格式不正確。" } };

  for (const k of ["loa_min", "loa_max"]) {
    const r = raw[k];
    if (isBlank(r)) continue;
    const L = k === "loa_min" ? "「船長下限」" : "「船長上限」";
    let n = NaN;
    if (typeof r === "number") n = r;
    else if (typeof r === "string" && /^-?\d+(\.\d+)?$/.test(r.trim())) n = Number(r.trim());
    if (!Number.isFinite(n)) errors[k] = L + "必須是數字。";
    else if (n < RULE_LOA_LIMIT_MIN || n > RULE_LOA_LIMIT_MAX) errors[k] = L + "必須介於 " + RULE_LOA_LIMIT_MIN + " 到 " + RULE_LOA_LIMIT_MAX + " 公尺。";
    else value[k] = n;
  }
  if (typeof value.loa_min === "number" && typeof value.loa_max === "number" && value.loa_min > value.loa_max) {
    errors.loa_max = "「船長上限」不能小於「船長下限」。";
  }

  for (const c of RULE_COND_LISTS) {
    const r = raw[c.key];
    if (r === undefined || r === null) continue;
    const opts = reqField(c.field).options;
    if (!Array.isArray(r) || r.some(x => typeof x !== "string" || !opts.includes(x))) {
      errors[c.key] = "「" + c.label + "」只能選：" + opts.join("、") + "。";
      continue;
    }
    const list = opts.filter(o => r.includes(o));   // 去重複、照選項順序
    if (list.length) value[c.key] = list;
  }
  return { value, errors };
}

// 新增／編輯條文的驗證：回 { data, errors }。條文編號、規則版本、生效日期可以先空白（存草稿）。
function validateRule(input) {
  const errors = {};
  const data = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { data, errors: { _form: "條文資料格式不正確。" } };
  }
  for (const f of RULE_TEXT_FIELDS) {
    const raw = input[f.key];
    if (raw !== undefined && raw !== null && typeof raw !== "string") { errors[f.key] = "「" + f.label + "」格式不正確。"; continue; }
    const v = typeof raw === "string" ? raw.trim() : "";
    if (!v && f.required) { errors[f.key] = "請填寫「" + f.label + "」。"; continue; }
    if (v.length > f.maxLength) { errors[f.key] = "「" + f.label + "」最多 " + f.maxLength + " 個字。"; continue; }
    data[f.key] = v;
  }
  if (typeof input.category !== "string" || !RULE_CATEGORIES.includes(input.category)) {
    errors.category = "請選擇分類：" + RULE_CATEGORIES.join("、") + "。";
  } else {
    data.category = input.category;
  }
  const d = input.effective_date;
  if (isBlank(d)) data.effective_date = "";
  else if (typeof d !== "string" || !isValidDate(d.trim())) errors.effective_date = "「生效日期」格式不正確（例如 2026-01-01）。";
  else data.effective_date = d.trim();

  const c = normalizeConditions(input.conditions);
  Object.assign(errors, c.errors);
  data.conditions = c.value;
  return { data, errors };
}

// 發佈前檢查：缺哪幾項（回 { 欄位key: 中文說明 }，空物件代表可以發佈）
function rulePublishMissing(rule) {
  const missing = {};
  for (const f of RULE_PUBLISH_REQUIRED) {
    if (isBlank(rule[f.key])) missing[f.key] = "缺少「" + f.label + "」，不能發佈。";
  }
  return missing;
}

// 從規格書（或需求暫存）資料取出對照用的參數；格式不對的當成沒填
function matchParamsFrom(data) {
  const params = {};
  for (const k of MATCH_PARAM_KEYS) {
    const f = reqField(k);
    const raw = data && typeof data === "object" ? data[k] : undefined;
    if (isEmptyValue(f, raw)) { params[k] = null; continue; }
    const r = validateField(f, raw);
    params[k] = r.error ? null : r.value;
  }
  return params;
}

// 對照一筆條文：回 { status: "match" | "confirm" | "no", reasons, missing }
// - 條件沒填的項目不影響。
// - 規格有填、但不在條件內 → "no"（不列出）。
// - 規格缺這個參數、條文卻需要 → 列為「需確認」，不算符合。
function matchRule(params, cond) {
  const c = cond && typeof cond === "object" ? cond : {};
  const reasons = [];
  const missing = [];
  let fails = false;

  const hasMin = typeof c.loa_min === "number";
  const hasMax = typeof c.loa_max === "number";
  if (hasMin || hasMax) {
    const need = hasMin && hasMax ? "介於 " + c.loa_min + "–" + c.loa_max + " m"
      : hasMin ? "≥ " + c.loa_min + " m" : "≤ " + c.loa_max + " m";
    if (typeof params.loa !== "number") missing.push("規格缺船長；條文適用船長 " + need);
    else if ((hasMin && params.loa < c.loa_min) || (hasMax && params.loa > c.loa_max)) fails = true;
    else reasons.push("船長 " + params.loa + " m " + need);
  }

  for (const L of RULE_COND_LISTS) {
    const list = c[L.key];
    if (!Array.isArray(list) || list.length === 0) continue;
    const v = params[L.field];
    if (v === null || v === undefined || v === "") missing.push("規格缺" + L.label + "；條文適用" + L.label + "：" + list.join("、"));
    else if (!list.includes(v)) fails = true;
    else reasons.push(L.label + "：" + v);
  }

  if (fails) return { status: "no", reasons: [], missing: [] };
  if (reasons.length === 0 && missing.length === 0) reasons.push("未設定適用條件（適用全部船舶）");
  return { status: missing.length ? "confirm" : "match", reasons, missing };
}

// 對照所有條文（呼叫端只傳 published 的）
function matchRules(params, rules) {
  const matched = [];
  const needsConfirm = [];
  for (const r of rules) {
    const m = matchRule(params, r.conditions);
    if (m.status === "match") matched.push(Object.assign({}, r, { reasons: m.reasons, missing: [] }));
    else if (m.status === "confirm") needsConfirm.push(Object.assign({}, r, { reasons: m.reasons, missing: m.missing }));
  }
  return { matched, needsConfirm };
}

function isAdmin(user) {
  return user.role === "admin";
}

const RULE_COLS =
  "r.id, r.article_no, r.category, r.title, r.summary, r.conditions, r.rule_version, r.effective_date, " +
  "r.status, r.updated_by, u.name AS updated_by_name, r.updated_at";
const RULE_FROM = "FROM rules r LEFT JOIN users u ON u.email = r.updated_by";
const RULE_ORDER = "ORDER BY instr('結構穩度消防機械電氣', r.category), r.article_no, r.id";

function ruleRow(row) {
  return {
    id: row.id,
    article_no: row.article_no,
    category: row.category,
    title: row.title,
    summary: row.summary,
    conditions: parseJsonColumn(row.conditions),
    rule_version: row.rule_version,
    effective_date: row.effective_date,
    status: row.status,
    updated_by: row.updated_by,
    updated_by_name: row.updated_by_name || null,
    updated_at: row.updated_at,
  };
}

async function loadRule(env, id) {
  const row = await env.DB.prepare(`SELECT ${RULE_COLS} ${RULE_FROM} WHERE r.id = ?1`).bind(id).first();
  return row ? ruleRow(row) : null;
}

// 每次寫入：把「寫入後」的整筆條文存成新的一列快照（版本號 = 該條文目前最大 + 1）
// ruleIdSql 是固定的 SQL 片段（"?1" 或 "COALESCE(?1, (SELECT last_insert_rowid()))"），不放使用者輸入
function revisionStmt(env, ruleIdSql, binds) {
  return env.DB.prepare(
    "INSERT INTO rule_revisions (rule_id, revision, action, snapshot, changed_by) " +
    "SELECT r.id, COALESCE((SELECT MAX(v.revision) FROM rule_revisions v WHERE v.rule_id = r.id), 0) + 1, ?2, " +
    "json_object('id', r.id, 'article_no', r.article_no, 'category', r.category, 'title', r.title, " +
    "'summary', r.summary, 'conditions', json(r.conditions), 'rule_version', r.rule_version, " +
    "'effective_date', r.effective_date, 'status', r.status, 'updated_by', r.updated_by, 'updated_at', r.updated_at), ?3 " +
    "FROM rules r WHERE r.id = " + ruleIdSql
  ).bind(...binds);
}

// 寫入（同一個 batch＝同一個交易）；撞到 UNIQUE(rule_id, revision) 就重試
async function runRuleBatch(env, makeStmts) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await env.DB.batch(makeStmts());
    } catch (e) {
      if (attempt < 2 && /UNIQUE/i.test(String(e && e.message))) continue;
      throw e;
    }
  }
  throw new Error("法規條文儲存失敗");
}

// GET /api/rules?q=&category=&status=
// staff：只看 published（帶其他 status 回 403）。admin：status 可為 published（預設）、draft、disabled、all。
async function listRules(user, env, url) {
  const sp = url.searchParams;
  const q = (sp.get("q") || "").trim();
  const category = (sp.get("category") || "").trim();
  const status = (sp.get("status") || "published").trim();

  if (q.length > RULE_QUERY_MAX) return error(400, "關鍵字最多 " + RULE_QUERY_MAX + " 個字。");
  if (category && !RULE_CATEGORIES.includes(category)) return error(400, "分類不正確。");
  if (status !== "all" && !RULE_STATUSES.includes(status)) return error(400, "狀態不正確。");
  if (status !== "published" && !isAdmin(user)) return error(403, "只有管理者可以看草稿或已停用的條文。");

  const where = [];
  const binds = [];
  if (status !== "all") { binds.push(status); where.push("r.status = ?" + binds.length); }
  if (category) { binds.push(category); where.push("r.category = ?" + binds.length); }
  if (q) {
    // LIKE 的萬用字元 % _ 和跳脫字元 \ 都先跳脫，使用者打的字一律當成一般文字
    binds.push("%" + q.replace(/[\\%_]/g, ch => "\\" + ch) + "%");
    const n = "?" + binds.length;
    where.push(`(r.article_no LIKE ${n} ESCAPE '\\' OR r.title LIKE ${n} ESCAPE '\\' OR r.summary LIKE ${n} ESCAPE '\\')`);
  }
  const sql = `SELECT ${RULE_COLS} ${RULE_FROM} ${where.length ? "WHERE " + where.join(" AND ") : ""} ${RULE_ORDER} LIMIT 500`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return json({ rules: (results || []).map(ruleRow) });
}

// GET /api/rules/:id：staff 只能看 published（其他回 404，不透露有草稿）
async function getRule(user, env, id) {
  const rule = await loadRule(env, id);
  if (!rule || (rule.status !== "published" && !isAdmin(user))) return error(404, "找不到這筆條文。");
  return json({ rule });
}

// POST /api/rules  body: { data: {...} }：一律存成草稿（admin）
async function createRule(request, user, env) {
  const rb = await readJsonBody(request);
  if (rb.response) return rb.response;
  const { data, errors } = validateRule(rb.body.data);
  if (Object.keys(errors).length) return validationError(errors);

  const results = await runRuleBatch(env, () => [
    env.DB.prepare(
      "INSERT INTO rules (article_no, category, title, summary, conditions, rule_version, effective_date, status, updated_by, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, datetime('now')) RETURNING id"
    ).bind(data.article_no, data.category, data.title, data.summary, JSON.stringify(data.conditions),
           data.rule_version, data.effective_date, user.email),
    // 這一句和上一句在同一個交易裡，last_insert_rowid() 就是剛新增的條文 id
    // （?1 綁 null，所以 COALESCE 會用 last_insert_rowid()）
    revisionStmt(env, "COALESCE(?1, (SELECT last_insert_rowid()))", [null, "create", user.email]),
    // 這時 last_insert_rowid() 是剛新增的修改紀錄 id
    env.DB.prepare(
      "INSERT INTO audit_log (actor_email, action, detail) " +
      "SELECT ?1, 'rule_create', '法規條文 #' || rule_id || ' 新增（草稿，修改紀錄 #' || revision || '）' " +
      "FROM rule_revisions WHERE id = (SELECT last_insert_rowid())"
    ).bind(user.email),
  ]);
  const row = results[0] && results[0].results && results[0].results[0];
  const rule = row ? await loadRule(env, row.id) : null;
  return json({ rule }, 201);
}

function ruleLabel(rule) {
  return "法規條文 #" + rule.id + (rule.article_no ? "（" + rule.article_no + "）" : "");
}

// 更新條文欄位或狀態，並在同一個交易裡新增修改紀錄與 audit_log
async function writeRuleChange(env, user, id, updateStmt, action, detail) {
  await runRuleBatch(env, () => [
    updateStmt(),
    revisionStmt(env, "?1", [id, action, user.email]),
    env.DB.prepare("INSERT INTO audit_log (actor_email, action, detail) VALUES (?1, ?2, ?3)")
      .bind(user.email, "rule_" + action, detail),
  ]);
  return loadRule(env, id);
}

// PUT /api/rules/:id  body: { data: {...} }：編輯內容，狀態保持不變（admin）
// 已發佈的條文編輯後仍是已發佈，所以三項必要資訊不能被清空。
async function updateRule(request, user, env, id) {
  const rb = await readJsonBody(request);
  if (rb.response) return rb.response;
  const old = await loadRule(env, id);
  if (!old) return error(404, "找不到這筆條文。");

  const { data, errors } = validateRule(rb.body.data);
  if (old.status === "published" && !errors._form) {
    const miss = rulePublishMissing(data);
    for (const k of Object.keys(miss)) if (!errors[k]) errors[k] = "已發佈的條文不能清空這一項。";
  }
  if (Object.keys(errors).length) return validationError(errors);

  const rule = await writeRuleChange(env, user, id, () => env.DB.prepare(
    "UPDATE rules SET article_no = ?2, category = ?3, title = ?4, summary = ?5, conditions = ?6, " +
    "rule_version = ?7, effective_date = ?8, updated_by = ?9, updated_at = datetime('now') WHERE id = ?1"
  ).bind(id, data.article_no, data.category, data.title, data.summary, JSON.stringify(data.conditions),
         data.rule_version, data.effective_date, user.email),
  "update", ruleLabel({ id, article_no: data.article_no }) + " 編輯");
  return json({ rule });
}

// POST /api/rules/:id/publish：條文編號、規則版本、生效日期缺任何一項就回 400（驗收 4.2 第二條）
async function publishRule(request, user, env, id) {
  const rb = await readJsonBody(request);   // 內容不用，但仍要求 JSON（防跨站送出）
  if (rb.response) return rb.response;
  const old = await loadRule(env, id);
  if (!old) return error(404, "找不到這筆條文。");
  if (old.status === "published") return error(409, "這筆條文已經是發佈狀態。");
  const miss = rulePublishMissing(old);
  if (Object.keys(miss).length) {
    return json({ error: "條文編號、規則版本、生效日期都要填才能發佈。", fields: miss }, 400);
  }
  const rule = await writeRuleChange(env, user, id, () => env.DB.prepare(
    "UPDATE rules SET status = 'published', updated_by = ?2, updated_at = datetime('now') WHERE id = ?1"
  ).bind(id, user.email), "publish", ruleLabel(old) + " 發佈");
  return json({ rule });
}

// POST /api/rules/:id/disable：停用（不刪除；之後可再發佈）
async function disableRule(request, user, env, id) {
  const rb = await readJsonBody(request);
  if (rb.response) return rb.response;
  const old = await loadRule(env, id);
  if (!old) return error(404, "找不到這筆條文。");
  if (old.status === "disabled") return error(409, "這筆條文已經是停用狀態。");
  const rule = await writeRuleChange(env, user, id, () => env.DB.prepare(
    "UPDATE rules SET status = 'disabled', updated_by = ?2, updated_at = datetime('now') WHERE id = ?1"
  ).bind(id, user.email), "disable", ruleLabel(old) + " 停用");
  return json({ rule });
}

// GET /api/rules/:id/revisions：修改紀錄（新到舊），含修改人、時間、動作、完整快照（admin）
async function listRuleRevisions(env, id) {
  const exists = await env.DB.prepare("SELECT 1 AS ok FROM rules WHERE id = ?1").bind(id).first();
  if (!exists) return error(404, "找不到這筆條文。");
  const { results } = await env.DB
    .prepare(`SELECT v.revision, v.action, v.snapshot, v.changed_by, u.name AS changed_by_name, v.changed_at
              FROM rule_revisions v LEFT JOIN users u ON u.email = v.changed_by
              WHERE v.rule_id = ?1 ORDER BY v.revision DESC`)
    .bind(id)
    .all();
  return json({
    revisions: (results || []).map(r => ({
      revision: r.revision,
      action: r.action,
      snapshot: parseJsonColumn(r.snapshot),
      changed_by: r.changed_by,
      changed_by_name: r.changed_by_name || null,
      changed_at: r.changed_at,
    })),
  });
}

// GET /api/projects/:id/rule-match（staff／admin，已過 loadProject）
// 取最新規格書版本；還沒有規格書就用需求暫存（並標示來源）。只對照 published 條文。
async function ruleMatch(env, project) {
  let source;
  let data = {};
  const spec = await env.DB
    .prepare("SELECT version, data, created_at FROM spec_versions WHERE project_id = ?1 ORDER BY version DESC LIMIT 1")
    .bind(project.id)
    .first();
  if (spec) {
    source = { type: "spec", version: spec.version, at: spec.created_at };
    data = parseJsonColumn(spec.data);
  } else {
    const draft = await env.DB
      .prepare("SELECT data, updated_at FROM requirement_drafts WHERE project_id = ?1")
      .bind(project.id)
      .first();
    if (draft) {
      source = { type: "draft", version: null, at: draft.updated_at };
      data = parseJsonColumn(draft.data);
    } else {
      source = { type: "none", version: null, at: null };
    }
  }
  const params = matchParamsFrom(data);
  const { results } = await env.DB
    .prepare(`SELECT ${RULE_COLS} ${RULE_FROM} WHERE r.status = 'published' ${RULE_ORDER}`)
    .all();
  const rules = (results || []).map(ruleRow);
  const { matched, needsConfirm } = matchRules(params, rules);
  return json({
    project: { id: project.id, name: project.name },
    source,
    params,
    checked: rules.length,
    matched,
    needs_confirm: needsConfirm,
  });
}

// /api/rules 底下的路由（已登入）
async function handleRules(request, user, env, url, path, method) {
  let id = null;
  let sub = "";
  if (path !== "/api/rules") {
    const m = path.match(/^\/api\/rules\/(\d{1,12})(\/publish|\/disable|\/revisions)?$/);
    if (!m) return error(404, "沒有這支 API。");
    id = Number(m[1]);
    sub = m[2] || "";
  }

  // 客戶一律不能碰法規資料（SDD 4.4：客戶進不了法規維護頁，後端一定要擋）
  if (!isStaffOrAdmin(user)) return error(403, "只有船廠人員可以使用法規資料。");

  let allowed;
  if (id === null) allowed = ["GET", "POST"];
  else if (sub === "") allowed = ["GET", "PUT"];
  else if (sub === "/revisions") allowed = ["GET"];
  else allowed = ["POST"];
  if (!allowed.includes(method)) return methodNotAllowed();

  // 維護（新增、編輯、發佈、停用、修改紀錄）只限管理者
  const adminOnly = method !== "GET" || sub === "/revisions";
  if (adminOnly && !isAdmin(user)) return error(403, "只有管理者可以維護法規資料。");

  if (id === null) return method === "GET" ? listRules(user, env, url) : createRule(request, user, env);
  if (sub === "") return method === "GET" ? getRule(user, env, id) : updateRule(request, user, env, id);
  if (sub === "/publish") return publishRule(request, user, env, id);
  if (sub === "/disable") return disableRule(request, user, env, id);
  return listRuleRevisions(env, id);
}

const ALLOWED_METHODS = ["GET", "PUT", "POST"];

function methodNotAllowed() {
  return error(405, "這支 API 不接受這種請求方式。");
}

async function handleApi(request, env, url) {
  const method = request.method;
  if (!ALLOWED_METHODS.includes(method)) return methodNotAllowed();

  // 寫入請求：如果瀏覽器帶了 Origin，必須是同一個網站（防跨站送出）
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return error(403, "不接受從其他網站送出的請求。");
  }

  // 先登入，再做任何事
  const auth = await authenticate(request, env);
  if (auth.response) return auth.response;
  const user = auth.user;

  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/me") return method === "GET" ? getMe(user) : methodNotAllowed();
  if (path === "/api/projects") return method === "GET" ? listProjects(user, env) : methodNotAllowed();

  if (path === "/api/rules" || path.startsWith("/api/rules/")) {
    return handleRules(request, user, env, url, path, method);
  }

  const m = path.match(/^\/api\/projects\/(\d{1,12})(\/.*)?$/);
  if (!m) return error(404, "沒有這支 API。");

  const sub = m[2] || "";
  const known =
    sub === "" || sub === "/requirements" || sub === "/spec" || sub === "/spec/generate" ||
    sub === "/spec/versions" || sub === "/comments" || sub === "/rule-match" ||
    /^\/spec\/versions\/\d{1,9}$/.test(sub) || /^\/spec\/restore\/\d{1,9}$/.test(sub);
  if (!known) return error(404, "沒有這支 API。");

  // 法規對照只限船廠人員與管理者（先擋角色，再查專案）
  if (sub === "/rule-match" && !isStaffOrAdmin(user)) return error(403, "只有船廠人員可以使用法規對照。");

  // 每支專案 API 都先檢查專案存取權（客戶只能碰自己的專案）
  const lp = await loadProject(user, env, Number(m[1]));
  if (lp.response) return lp.response;
  const project = lp.project;

  if (sub === "") return method === "GET" ? getProject(project) : methodNotAllowed();

  if (sub === "/rule-match") return method === "GET" ? ruleMatch(env, project) : methodNotAllowed();

  if (sub === "/requirements") {
    if (method === "GET") return getRequirements(env, project);
    if (method === "PUT") return putRequirements(request, user, env, project);
    return methodNotAllowed();
  }

  if (sub === "/spec") {
    if (method === "GET") return getLatestSpec(env, project);
    if (method === "POST") return saveSpec(request, user, env, project);
    return methodNotAllowed();
  }

  if (sub === "/spec/generate") {
    return method === "POST" ? generateSpec(request, user, env, project) : methodNotAllowed();
  }

  if (sub === "/spec/versions") {
    return method === "GET" ? listSpecVersions(env, project) : methodNotAllowed();
  }

  let mv = sub.match(/^\/spec\/versions\/(\d{1,9})$/);
  if (mv) return method === "GET" ? getSpecVersion(env, project, Number(mv[1])) : methodNotAllowed();

  mv = sub.match(/^\/spec\/restore\/(\d{1,9})$/);
  if (mv) return method === "POST" ? restoreSpec(request, user, env, project, Number(mv[1])) : methodNotAllowed();

  if (sub === "/comments") {
    if (method === "GET") return listComments(env, project);
    if (method === "POST") return addComment(request, user, env, project);
    return methodNotAllowed();
  }

  return error(404, "沒有這支 API。");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        // 不把內部錯誤細節回給使用者
        console.error(e);
        return error(500, "伺服器發生錯誤，請稍後再試。");
      }
    }

    // 其他路徑交給靜態檔（public/）
    return env.ASSETS.fetch(request);
  },
};
