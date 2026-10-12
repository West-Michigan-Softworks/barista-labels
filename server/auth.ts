import { createRemoteJWKSet, jwtVerify } from "jose";
import type { FastifyRequest } from "fastify";

export interface Identity {
  id: string;
  roles: string[];
}
const tenant = process.env.ENTRA_TENANT_ID;
const audience = process.env.ENTRA_API_AUDIENCE;
const keys = tenant
  ? createRemoteJWKSet(
      new URL(
        `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
      ),
    )
  : undefined;
export const authConfiguration = () => ({
  tenantId: tenant ?? "",
  clientId: process.env.ENTRA_CLIENT_ID ?? "",
  scope: process.env.ENTRA_API_SCOPE ?? "",
  devAuth: process.env.BARISTA_DEV_AUTH === "true",
});
export async function authenticate(request: FastifyRequest): Promise<Identity> {
  const address = request.ip;
  if (
    process.env.BARISTA_DEV_AUTH === "true" &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)
  )
    return { id: "local-developer", roles: ["Labels.Admin", "Labels.User"] };
  if (!tenant || !audience || !keys)
    throw Object.assign(new Error("Authentication is not configured"), {
      statusCode: 503,
    });
  const token = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!token)
    throw Object.assign(new Error("Sign in required"), { statusCode: 401 });
  try {
    const unverified = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "{}");
    console.error("TOKEN CLAIMS PRE-VERIFY:", JSON.stringify({
      aud: unverified.aud,
      iss: unverified.iss,
      tid: unverified.tid,
      scp: unverified.scp,
      roles: unverified.roles,
      sub: unverified.sub,
      oid: unverified.oid,
    }, null, 2));

    const { payload } = await jwtVerify(token, keys, {
      issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      audience,
      algorithms: ["RS256"],
    });
    const roles = Array.isArray(payload.roles)
      ? payload.roles.filter((v): v is string => typeof v === "string")
      : [];
    const requiredScope = process.env.ENTRA_REQUIRED_SCOPE ?? "Labels.Access";
    const identity = payload.oid ?? payload.sub;
    if (payload.tid !== tenant) {
      throw new Error(`Tenant mismatch: token has ${payload.tid}, expected ${tenant}`);
    }
    if (typeof payload.exp !== "number") {
      throw new Error("Token missing exp claim");
    }
    if (typeof identity !== "string" || !identity) {
      throw new Error("Token missing identity (oid/sub)");
    }
    if (typeof payload.scp !== "string" || !payload.scp.split(" ").includes(requiredScope)) {
      throw new Error(`Scope mismatch: token has scp='${payload.scp}', required='${requiredScope}'`);
    }
    if (!roles.some((role) => ["Labels.User", "Labels.Admin"].includes(role))) {
      throw new Error(`Role missing: token roles=[${roles.join(", ")}], required Labels.User or Labels.Admin`);
    }
    return { id: identity, roles };
  } catch (error: any) {
    console.error("AUTH VALIDATION FAILED REASON:", error?.message || error);
    request.log.error(error, "Authentication failure");
    throw Object.assign(
      new Error(`Invalid access token or insufficient access: ${error?.message || error}`),
      { statusCode: 401 },
    );
  }
}
export function requireAdmin(identity: Identity) {
  if (!identity.roles.includes("Labels.Admin"))
    throw Object.assign(new Error("Administrator role required"), {
      statusCode: 403,
    });
}
export function requireOwner(identity: Identity, record: { userId?: string }) {
  if (record.userId !== identity.id) requireAdmin(identity);
}
