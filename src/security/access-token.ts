import { SignJWT } from "jose";
import { env } from "../config/env.js";

import { JWT_ISSUER, JWT_AUDIENCE } from "./jwt.constants.js";

export async function createAccessToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(env.jwtAccessTokenTtl)
    .sign(env.jwtAccessSecret);
}