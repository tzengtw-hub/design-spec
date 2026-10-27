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
