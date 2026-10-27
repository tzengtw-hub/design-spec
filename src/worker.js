// 遊艇訂製網站：Cloudflare Worker 後端（SDD-001，技術見 ADR-0002）
// 純 JavaScript（ES module），不用打包工具、不用 npm 套件。
//
// 請求怎麼走：
//   /api/*  → 先進這支 Worker（wrangler.jsonc 的 assets.run_worker_first）
//   其他    → 直接回 public/ 底下的靜態檔（前端畫面）
//
// 權限規則（重要）：每一支 API 都要先經過 authenticate()，拿到「登入者 + 角色」才可以讀資料。
// 前端藏按鈕只是畫面，真正的擋在這裡。

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

// GET /api/projects/:id：客戶讀別人的專案回 403
async function getProject(user, env, id) {
  const project = await env.DB
    .prepare("SELECT id, name, boat_type, status, owner_email, created_at FROM projects WHERE id = ?1")
    .bind(id)
    .first();

  if (!project) {
    // 客戶問不存在的專案也回 403，避免從 404／403 的差別猜出別人有哪些專案編號。
    if (!isStaffOrAdmin(user)) return error(403, "你沒有權限看這個專案。");
    return error(404, "找不到這個專案。");
  }

  if (!isStaffOrAdmin(user) && String(project.owner_email).toLowerCase() !== user.email.toLowerCase()) {
    return error(403, "你沒有權限看這個專案。");
  }

  return json({ project });
}

// ---------- 路由 ----------

async function handleApi(request, env, url) {
  if (request.method !== "GET") {
    return error(405, "目前只開放讀取。");
  }

  // 先登入，再做任何事
  const auth = await authenticate(request, env);
  if (auth.response) return auth.response;
  const user = auth.user;

  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/me") return getMe(user);
  if (path === "/api/projects") return listProjects(user, env);

  const m = path.match(/^\/api\/projects\/(\d+)$/);
  if (m) return getProject(user, env, Number(m[1]));

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
