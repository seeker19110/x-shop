-- Vai trò DB tách quyền (T-184, Q-02; DB-SEC-002) — chạy qua scripts/db-roles.sh (dev: dev-services.sh; CI: ci.yml).
-- Lũy đẳng, chạy lại an toàn; cần vai trò quản trị (superuser) của cluster. Biến psql (-v):
--   app_password, migrator_password — mật khẩu dev/CI GIẢ (chứa SENTINEL) hoặc lấy từ env;
--   legacy_owner — vai trò đang tạo bảng ở DB này (dev/CI: xshop) để default privileges phủ bảng nó tạo sau này.
-- Cấp CLUSTER: tạo xshop_migrator + xshop_app và thuộc tính của chúng. Cấp DB (DB đang kết nối): quyền schema/bảng/sequence
-- cho xshop_app — trùng khối GRANTS của migration Migration20261029120000 (module checkout): migration phủ DB mới/DB test/
-- production; ở đây phủ DB dev đã migrate TRƯỚC khi có vai trò (migration đã ghi nhận nên không chạy lại).
-- Timeout cấp vai trò (statement_timeout, idle_in_transaction_session_timeout) KHÔNG đặt ở đây — nguồn duy nhất là
-- migration trên (DB-PERF-005).

\set ON_ERROR_STOP on
-- NOTICE "đã cấp membership" khi chạy lại không phải lỗi — chỉ in từ WARNING trở lên.
SET client_min_messages = warning;

-- Hai lần chạy đồng thời (nhiều worktree) cùng ALTER ROLE một vai trò → "tuple concurrently updated". Khoá advisory theo
-- phiên trên DB đang kết nối (mọi lần chạy cùng DB quản trị) xếp hàng chúng; nhả khi psql thoát.
SELECT pg_advisory_lock(hashtext('x-shop:db-roles')) \g /dev/null

DO $$
BEGIN
  CREATE ROLE xshop_migrator NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE ROLE xshop_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END $$;

-- Migration: owner/DDL trên DB của nó (do hạ tầng giao DB), không superuser/không tạo DB/không bỏ qua RLS. CREATEROLE (+ ADMIN
-- OPTION trên xshop_app ở dưới) chỉ để migration ALTER ROLE xshop_app SET … được (Postgres 16: vai trò CREATEROLE chỉ sửa
-- được vai trò nó có ADMIN OPTION).
ALTER ROLE xshop_migrator WITH LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
  PASSWORD :'migrator_password';

-- Ứng dụng: chỉ DML qua GRANT, không thuộc tính đặc quyền nào.
ALTER ROLE xshop_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
  PASSWORD :'app_password';

-- ADMIN OPTION để quản lý xshop_app; INHERIT/SET FALSE: migrator KHÔNG nhận quyền và không SET ROLE thành xshop_app.
GRANT xshop_app TO xshop_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;

-- Cấp DB (DB đang kết nối).
GRANT USAGE ON SCHEMA public TO xshop_app;
REVOKE CREATE ON SCHEMA public FROM xshop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO xshop_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO xshop_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"legacy_owner", xshop_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO xshop_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"legacy_owner", xshop_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO xshop_app;

SELECT pg_advisory_unlock(hashtext('x-shop:db-roles')) \g /dev/null
