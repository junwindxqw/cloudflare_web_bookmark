-- 云书签 D1 表结构（多用户版，供参考/手动初始化用）
-- 正常使用无需执行本文件：Worker 首次处理请求时会自动执行相同的幂等建表语句，
-- 老版本（v1 单用户）数据库会自动 ALTER 补 user_id 列完成迁移。
-- 如需手动初始化：npx wrangler d1 execute cloud-bookmark-db --remote --file=./schema.sql

-- 用户表：首个注册用户由应用逻辑置为 admin
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,              -- pbkdf2_sha256$iterations$salt$hash
  role          TEXT    NOT NULL DEFAULT 'user', -- 'admin' | 'user'
  created_at    TEXT    NOT NULL
);

-- 会话表：数据库只存令牌的 SHA-256 哈希，Cookie 中保存原始令牌
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- 邮箱验证码表：注册（register）/ 找回密码（reset）共用，一箱一码
CREATE TABLE IF NOT EXISTS email_codes (
  email      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,                    -- 4 位数字，10 分钟有效
  purpose    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,       -- 错 5 次作废
  created_at TEXT NOT NULL                     -- 同时用于 60s 重发冷却
);

-- 简单限流表：登录失败锁定、同 IP 发码限频
CREATE TABLE IF NOT EXISTS auth_throttle (
  key          TEXT    PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start TEXT    NOT NULL
);

-- 书签表：按用户隔离；(user_id, url) 联合唯一，不同用户可收藏同一网址
CREATE TABLE IF NOT EXISTS bookmarks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL DEFAULT 0,      -- 0 为 v1 单用户版历史数据，由首个管理员注册时自动认领
  url         TEXT    NOT NULL,
  title       TEXT    NOT NULL DEFAULT '',
  description TEXT    NOT NULL DEFAULT '',
  icon_url    TEXT    NOT NULL DEFAULT '',
  category    TEXT    NOT NULL DEFAULT '',     -- 自动分类 id（tech/ai/design/.../other），前端 src/category.js 词典同源
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  UNIQUE (user_id, url)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks (user_id, id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_category ON bookmarks (user_id, category);

-- ⚠️ 从 v1 单用户库升级的说明：
-- v1 的 bookmarks 表使用 UNIQUE(url) 全局唯一约束。应用启动时会自动 ALTER 补 user_id 列，
-- 但老约束仍在（同网址无法被第二个用户收藏）。如需彻底重建，可执行：
--   CREATE TABLE bookmarks_new (...同上，含 UNIQUE(user_id, url)...);
--   INSERT INTO bookmarks_new SELECT id, user_id, url, title, description, icon_url, created_at, updated_at FROM bookmarks;
--   DROP TABLE bookmarks; ALTER TABLE bookmarks_new RENAME TO bookmarks;
--   CREATE INDEX idx_bookmarks_user ON bookmarks (user_id, id);
-- 全新部署不受影响。
