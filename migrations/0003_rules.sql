-- 0003_rules.sql：RINA 法規重點摘要與修改紀錄（SDD-001 功能 2、畫面 5、6、8、驗收 4.2）
-- 套用方式見 docs/dev.md。不修改 0001、0002 的任何資料表。
-- 改資料表結構的變更，合併前要先問使用者。
--
-- 注意：這裡只放船廠自行整理的「重點摘要」與條文編號，不放 RINA 規則原文（SDD 不做的事）。

-- 法規摘要：每筆一列
-- conditions 是 JSON 文字（結構化適用條件），全部選填，沒填的代表不限：
--   { "loa_min": 24, "loa_max": 40,              -- 船長（公尺），含等於
--     "boat_types":  ["機動遊艇","帆船","雙體船"],
--     "areas":       ["近岸","沿海","遠洋"],
--     "usages":      ["私人","商業包租"],
--     "propulsions": ["柴油內燃機","油電混合","純電"] }
--   選項值與 SDD-001 附錄 A 一致（後端 src/worker.js 的 REQ_FIELDS）。
-- article_no、rule_version、effective_date 草稿時可以空白（存成 ''），
-- 但「已發佈」一定三項都要有（驗收 4.2 第二條；後端也會先擋）。
CREATE TABLE IF NOT EXISTS rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  article_no     TEXT NOT NULL DEFAULT '',
  category       TEXT NOT NULL CHECK (category IN ('結構', '穩度', '消防', '機械', '電氣')),
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL DEFAULT '',
  conditions     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(conditions)),
  rule_version   TEXT NOT NULL DEFAULT '',
  effective_date TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'disabled')),
  updated_by     TEXT NOT NULL COLLATE NOCASE,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status <> 'published' OR (article_no <> '' AND rule_version <> '' AND effective_date <> ''))
);

CREATE INDEX IF NOT EXISTS idx_rules_status_category ON rules(status, category);

-- 修改紀錄：每次新增、編輯、發佈、停用都「新增一列」完整快照，永不覆蓋、永不刪除
-- revision 是同一筆條文內的序號 1、2、3…
-- snapshot 是當下整筆條文的 JSON（含 conditions、status、修改人、時間）
CREATE TABLE IF NOT EXISTS rule_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id    INTEGER NOT NULL REFERENCES rules(id),
  revision   INTEGER NOT NULL CHECK (revision >= 1),
  action     TEXT NOT NULL CHECK (action IN ('create', 'update', 'publish', 'disable')),
  snapshot   TEXT NOT NULL CHECK (json_valid(snapshot)),
  changed_by TEXT NOT NULL COLLATE NOCASE,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rule_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_rule_revisions_rule ON rule_revisions(rule_id, revision);
