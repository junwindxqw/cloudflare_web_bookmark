-- 云书签 D1 表结构（供参考/手动初始化用）
-- 正常使用无需执行本文件：Worker 首次处理请求时会自动执行相同的建表语句（CREATE TABLE IF NOT EXISTS）。
-- 如需手动初始化：npx wrangler d1 execute cloud-bookmark-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS bookmarks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT    NOT NULL UNIQUE,       -- 归一化后的网址（去 hash、去默认端口）
  title       TEXT    NOT NULL DEFAULT '',   -- 标题（缺省时取自 <title>/og:title，兜底为域名）
  description TEXT    NOT NULL DEFAULT '',   -- 描述（取自 meta description / og:description）
  icon_url    TEXT    NOT NULL DEFAULT '',   -- 图标地址（抓取失败时前端用字母头像兜底）
  created_at  TEXT    NOT NULL,              -- ISO 8601 时间
  updated_at  TEXT    NOT NULL               -- ISO 8601 时间
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at ON bookmarks (created_at);
