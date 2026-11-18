import 'dotenv/config';

const jwtAccessSecret = process.env.JWT_ACCESS_SECRET;
const jwtAccessTokenTtl = process.env.JWT_ACCESS_TOKEN_TTL;
const refreshTokenTtlDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS);
const port = Number(process.env.PORT ?? 3000);
const nodeEnv = process.env.NODE_ENV ?? "development";

if (!jwtAccessSecret) {
  throw new Error("JWT_ACCESS_SECRET is required");
}

if (!jwtAccessTokenTtl) {
  throw new Error("JWT_ACCESS_TOKEN_TTL is required");
}
if (!/^\d+[smhd]$/.test(jwtAccessTokenTtl)) {
  throw new Error("JWT_ACCESS_TOKEN_TTL must use a duration such as 15m, 1h, or 1d");
}

if (!Number.isInteger(refreshTokenTtlDays) || refreshTokenTtlDays <= 0) {
  throw new Error("REFRESH_TOKEN_TTL_DAYS must be a positive integer");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}
const secretBytes = Buffer.from(jwtAccessSecret, "base64");

if (secretBytes.length !== 32 || secretBytes.toString("base64") !== jwtAccessSecret) {
  throw new Error("JWT_ACCESS_SECRET must contain 32 bytes");
}



export const env = {
  jwtAccessSecret: secretBytes,
  jwtAccessTokenTtl,
  refreshTokenTtlDays,
  port,
  nodeEnv,
  databaseUrl: process.env.DATABASE_URL
};
