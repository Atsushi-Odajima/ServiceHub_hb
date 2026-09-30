#!/bin/sh
# PostgreSQL コンテナの初回起動時だけ実行される(docker-entrypoint-initdb.d)。
# アプリ用のロールは superuser / BYPASSRLS を持たない一般ロールにする(組織間のデータ分離を DB でも強制するため)。
set -e
psql -v ON_ERROR_STOP=1 -v app_pw="$APP_DB_PASSWORD" --username "$POSTGRES_USER" --dbname postgres <<'EOSQL'
CREATE ROLE servicehub LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE servicehub OWNER servicehub;
EOSQL
