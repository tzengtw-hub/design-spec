-- 0001_init.sql：遊艇訂製網站的第一批資料表（SDD-001、ADR-0002）
-- 套用方式見 docs/dev.md。改資料表結構的變更，合併前要先問使用者。

-- 使用者：誰可以用這個系統、是什麼角色
-- email 要和 Cloudflare Access 登入的 email 一樣
CREATE TABLE IF NOT EXISTS users (
  email      TEXT PRIMARY KEY COLLATE NOCASE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('customer', 'staff', 'admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 專案：一艘船的訂製案
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  boat_type   TEXT NOT NULL,
  status      TEXT NOT NULL,
  owner_email TEXT NOT NULL COLLATE NOCASE REFERENCES users(email),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_email);

-- 操作紀錄：誰、何時、做了什麼
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_email TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
