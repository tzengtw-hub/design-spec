-- seed_demo.sql：示範用假資料（只給本機或測試環境用，不要灌進正式資料庫）
-- 全部都是假的人和假的專案，email 一律用 @example.com。
-- 套用方式見 docs/dev.md。

INSERT OR IGNORE INTO users (email, name, role) VALUES
  ('customer1@example.com', '示範客戶一', 'customer'),
  ('customer2@example.com', '示範客戶二', 'customer'),
  ('staff1@example.com',    '示範船廠人員', 'staff'),
  ('admin1@example.com',    '示範管理者', 'admin');

INSERT OR IGNORE INTO projects (id, name, boat_type, status, owner_email) VALUES
  (1, '示範專案 A-1', '機動遊艇', '需求填寫中', 'customer1@example.com'),
  (2, '示範專案 A-2', '帆船',     '規格書審閱', 'customer1@example.com'),
  (3, '示範專案 B-1', '雙體船',   '需求填寫中', 'customer2@example.com'),
  (4, '示範專案 B-2', '機動遊艇', '圖面審查中', 'customer2@example.com');

INSERT INTO audit_log (actor_email, action, detail) VALUES
  ('admin1@example.com', 'seed_demo', '匯入示範假資料');

-- ---------- 法規摘要假資料（SDD-001 附錄 C；需要先套用 migrations/0003_rules.sql） ----------
-- 全部是假的：條文編號一律 DEMO- 開頭，不是 RINA 條文，也不是 RINA 原文。
-- 內容和 public/index.html 的 DEMO_RULES 一致；改一邊要記得改另一邊。
-- 第 1–12 筆：附錄 C（已發佈）。第 13 筆：草稿（缺規則版本與生效日期，用來測「不能發佈」）。第 14 筆：已停用。
INSERT OR IGNORE INTO rules (id, article_no, category, title, summary, conditions, rule_version, effective_date, status, updated_by) VALUES
  (1,  'DEMO-STR-01',   '結構', '示範：大型船船體結構',       '（示範用）此處放船廠整理的重點摘要：船長 24 公尺以上的船體結構要點。', '{"loa_min":24}',                      'DEMO-2026', '2026-01-01', 'published', 'admin1@example.com'),
  (2,  'DEMO-STR-02',   '結構', '示範：船體結構通則',         '（示範用）此處放船廠整理的重點摘要：所有船都適用的結構通則。',         '{}',                                  'DEMO-2026', '2026-01-01', 'published', 'admin1@example.com'),
  (3,  'DEMO-STB-01',   '穩度', '示範：大型船完整穩度',       '（示範用）此處放船廠整理的重點摘要：船長 24 公尺以上的穩度要點。',     '{"loa_min":24}',                      'DEMO-2026', '2026-01-01', 'published', 'admin1@example.com'),
  (4,  'DEMO-STB-02',   '穩度', '示範：遠洋航區穩度',         '（示範用）此處放船廠整理的重點摘要：遠洋航區的穩度要點。',             '{"areas":["遠洋"]}',                  'DEMO-2026', '2026-01-01', 'published', 'admin1@example.com'),
  (5,  'DEMO-FIRE-01',  '消防', '示範：消防設備通則',         '（示範用）此處放船廠整理的重點摘要：所有船都適用的消防設備要點。',     '{}',                                  'DEMO-2026', '2026-01-01', 'published', 'admin1@example.com'),
  (6,  'DEMO-FIRE-02',  '消防', '示範：商業包租船消防',       '（示範用）此處放船廠整理的重點摘要：商業包租用途的消防要點。',         '{"usages":["商業包租"]}',             'DEMO-2026', '2026-01-01', 'published', 'admin1@example.com'),
  (7,  'DEMO-MAC-01',   '機械', '示範：柴油主機裝置',         '（示範用）此處放船廠整理的重點摘要：柴油內燃機動力的機械要點。',       '{"propulsions":["柴油內燃機"]}',      'DEMO-2026', '2026-01-01', 'published', 'admin1@example.com'),
  (8,  'DEMO-MAC-02',   '機械', '示範：遠洋航區機械備品',     '（示範用）此處放船廠整理的重點摘要：遠洋航區的機械備品要點。',         '{"areas":["遠洋"]}',                  'DEMO-2026', '2026-01-01', 'published', 'admin1@example.com'),
  (9,  'DEMO-ELE-01',   '電氣', '示範：電氣裝置通則',         '（示範用）此處放船廠整理的重點摘要：所有船都適用的電氣要點。',         '{}',                                  'DEMO-2026', '2026-01-01', 'published', 'admin1@example.com'),
  (10, 'DEMO-ELE-02',   '電氣', '示範：電池與電力推進',       '（示範用）此處放船廠整理的重點摘要：油電混合或純電動力的電氣要點。',   '{"propulsions":["油電混合","純電"]}', 'DEMO-2026', '2026-01-01', 'published', 'admin1@example.com'),
  (11, 'DEMO-ELE-03',   '電氣', '示範：大型船電力系統',       '（示範用）此處放船廠整理的重點摘要：船長 40 公尺以上的電力系統要點。', '{"loa_min":40}',                      'DEMO-2026', '2026-01-01', 'published', 'admin1@example.com'),
  (12, 'DEMO-STR-03',   '結構', '示範：沿海及遠洋航區結構補強', '（示範用）此處放船廠整理的重點摘要：沿海或遠洋航區的結構補強要點。', '{"areas":["沿海","遠洋"]}',           'DEMO-2026', '2026-01-01', 'published', 'admin1@example.com'),
  (13, 'DEMO-DRAFT-01', '穩度', '示範草稿：帆船穩度（未完成）', '（示範用）草稿，還缺規則版本與生效日期，所以還不能發佈。',           '{"boat_types":["帆船"]}',             '',          '',           'draft',     'admin1@example.com'),
  (14, 'DEMO-OLD-01',   '消防', '示範已停用：舊版消防規定',   '（示範用）已停用的舊摘要，查詢與對照都不會出現。',                     '{}',                                  'DEMO-2025', '2025-01-01', 'disabled',  'admin1@example.com');

-- 每筆假條文的第一筆修改紀錄（完整快照）。UNIQUE(rule_id, revision) 讓重複執行不會多出列。
INSERT OR IGNORE INTO rule_revisions (rule_id, revision, action, snapshot, changed_by, changed_at)
  SELECT r.id, 1, 'create',
         json_object('id', r.id, 'article_no', r.article_no, 'category', r.category, 'title', r.title,
                     'summary', r.summary, 'conditions', json(r.conditions), 'rule_version', r.rule_version,
                     'effective_date', r.effective_date, 'status', r.status,
                     'updated_by', r.updated_by, 'updated_at', r.updated_at),
         r.updated_by, r.updated_at
  FROM rules r WHERE r.id BETWEEN 1 AND 14;
