-- 0002_specs.sql：需求暫存、規格書版本、規格書意見（SDD-001 功能 1、畫面 3 與 4、驗收 4.1）
-- 套用方式見 docs/dev.md。不修改 0001 的任何資料表。
-- 改資料表結構的變更，合併前要先問使用者。

-- 需求暫存：每個專案一份（客戶分步驟填寫、可暫存）
-- data 是 JSON 文字，欄位依 SDD-001 附錄 A（後端 src/worker.js 的 REQ_FIELDS）
CREATE TABLE IF NOT EXISTS requirement_drafts (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id),
  data       TEXT NOT NULL,
  updated_by TEXT NOT NULL COLLATE NOCASE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 規格書版本：每次儲存「新增一列」，永不覆蓋、永不刪除
-- version 是同一專案內的序號 1、2、3…
-- note 例如「由需求產生」「編輯後儲存」「還原自 v2」
CREATE TABLE IF NOT EXISTS spec_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  version    INTEGER NOT NULL CHECK (version >= 1),
  data       TEXT NOT NULL,
  created_by TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  note       TEXT,
  UNIQUE (project_id, version)
);

CREATE INDEX IF NOT EXISTS idx_spec_versions_project ON spec_versions(project_id, version);

-- 規格書意見：船廠人員加註，標記為「客戶需求」或「船廠建議」
-- field_key 可空（空的代表針對整份規格書）
CREATE TABLE IF NOT EXISTS spec_comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id),
  spec_version INTEGER NOT NULL,
  field_key    TEXT,
  type         TEXT NOT NULL CHECK (type IN ('customer_request', 'yard_suggestion')),
  content      TEXT NOT NULL,
  author_email TEXT NOT NULL COLLATE NOCASE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_spec_comments_project ON spec_comments(project_id, created_at);
