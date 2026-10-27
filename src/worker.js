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

// ---------- 登入（共用，每支 API 都要經過） ----------
//
// 正式環境：Cloudflare Access 在請求進到 Worker 之前就驗證好使用者，
//          並帶上標頭 Cf-Access-Authenticated-User-Email。
// 本機開發：只有環境變數 DEV_AUTH 剛好等於 "1" 時，才接受標頭 X-Dev-User 代替。
//          DEV_AUTH 只能放在本機的 .dev.vars，絕對不可以設在正式環境。
//
// 回傳：{ user: { email, name, role } } 或 { response: <錯誤回應> }
export async function authenticate(request, env) {
  let email = request.headers.get("Cf-Access-Authenticated-User-Email");

  if (!email && env.DEV_AUTH === "1") {
    email = request.headers.get("X-Dev-User");
  }

  email = (email || "").trim().toLowerCase();
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
