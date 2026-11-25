-- ログイン（Better Auth 1.7.18。web のサーバー（Next.js）の中で動く）の表。何度流しても同じになる形（IF NOT EXISTS）。既存の表・行は変えない。
-- schema.sql と同じ仕組みで適用する（app/db.py の apply_schema。api の起動時とローダーの実行時。すでにあるボリュームにも入る）。
--
-- 形は JobNavi の backend/app/migrations/0004_better_auth.sql と同じ（名前は auth_ 付き。web の `modelName` と同じ）。
-- Better Auth の表の列名は、ライブラリが決めたまま（camelCase。引用符つき）にしてある。形は、同じ設定から `getMigrations(auth.options).compileMigrations()` で生成した SQL。
-- 版を上げて列が変わるときは、このファイルを書き換えず、新しいファイル（auth_v2.sql など）で足す。
-- auth_ の表は、web のサーバー（Better Auth）が読み書きする。API は読まない（JWT を JWKS で検証するだけ）。DB のユーザーは API と同じ（表ごとの権限分けはしない）。
-- TownScan には、利用者のプロフィールの表は無い（ログインは任意。JWT の sub を結ぶ先は無い）。

-- 「だれか」。Google のアカウントごとに 1 行。id は Better Auth が作る文字列（JWT の sub になる）。
CREATE TABLE IF NOT EXISTS auth_user (
  "id"            text        NOT NULL PRIMARY KEY,
  "name"          text        NOT NULL,
  "email"         text        NOT NULL UNIQUE,
  "emailVerified" boolean     NOT NULL,
  "image"         text,
  "createdAt"     timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastName"      text,
  "firstName"     text
);

-- ログイン中の印。token は Cookie の値（署名つき）の元になる。
CREATE TABLE IF NOT EXISTS auth_session (
  "id"        text        NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token"     text        NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId"    text        NOT NULL REFERENCES auth_user ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS auth_session_userId_idx ON auth_session ("userId");

-- 外のログイン元（Google）との結び。Google のアクセス・更新トークンは、アプリ側の設定（encryptOAuthTokens）で暗号化して入れる（ID トークンは、ライブラリの仕様で暗号化されない）。
CREATE TABLE IF NOT EXISTS auth_account (
  "id"                    text        NOT NULL PRIMARY KEY,
  "accountId"             text        NOT NULL,
  "providerId"            text        NOT NULL,
  "userId"                text        NOT NULL REFERENCES auth_user ("id") ON DELETE CASCADE,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope"                 text,
  "password"              text,
  "createdAt"             timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_account_userId_idx ON auth_account ("userId");

-- ログインの途中の一時的な値（OAuth の state など）。期限つき。
CREATE TABLE IF NOT EXISTS auth_verification (
  "id"         text        NOT NULL PRIMARY KEY,
  "identifier" text        NOT NULL,
  "value"      text        NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS auth_verification_identifier_idx ON auth_verification ("identifier");

-- JWT の署名鍵（ES256）。privateKey は Better Auth が BETTER_AUTH_SECRET で暗号化して入れる（Secret を変えると読めなくなる）。publicKey は /api/auth/jwks で公開される。
CREATE TABLE IF NOT EXISTS auth_jwks (
  "id"         text        NOT NULL PRIMARY KEY,
  "publicKey"  text        NOT NULL,
  "privateKey" text        NOT NULL,
  "createdAt"  timestamptz NOT NULL,
  "expiresAt"  timestamptz,
  "alg"        text,
  "crv"        text
);
