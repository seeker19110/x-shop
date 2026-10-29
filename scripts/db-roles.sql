-- Vai trò DB tách quyền (T-184, Q-02; DB-SEC-002; D-138) — CẤP CLUSTER. Chạy qua scripts/db-roles.sh (dev: dev-services.sh;
-- CI: ci.yml), ngay sau đó db-roles.sh chạy scripts/db-app-grants.sql (cấp DB) trong CÙNG phiên psql.
-- Lũy đẳng, chạy lại an toàn (kể cả sửa vai trò do bản trước của script tạo); cần vai trò quản trị (superuser). Biến psql
-- (-v): app_password, migrator_password — mật khẩu dev/CI GIẢ (chứa SENTINEL) hoặc lấy từ env.

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

-- Migration: owner/DDL trên DB của nó (do hạ tầng giao DB). KHÔNG CREATEROLE (review T-184: CREATEROLE + ADMIN OPTION cho
-- phép tạo vai trò đăng nhập cửa hậu, đổi mật khẩu/NOLOGIN xshop_app, tự cấp INHERIT/SET). Không superuser/tạo DB/bỏ qua RLS.
ALTER ROLE xshop_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
  PASSWORD :'migrator_password';

-- Ứng dụng: chỉ DML qua GRANT, không thuộc tính đặc quyền nào.
ALTER ROLE xshop_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
  PASSWORD :'app_password';

-- SET TRUE: migration chạy `ALTER ROLE xshop_app SET <timeout>` DƯỚI vai trò xshop_app (vai trò thường tự đặt mặc định
-- của nó được). ADMIN FALSE: không cấp xshop_app cho ai, không đổi mật khẩu/thuộc tính của nó. INHERIT FALSE: không tự
-- nhận quyền của xshop_app. REVOKE ADMIN OPTION trước: bản cũ của script cấp ADMIN TRUE, GRANT không hạ được ADMIN.
REVOKE ADMIN OPTION FOR xshop_app FROM xshop_migrator;
GRANT xshop_app TO xshop_migrator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
