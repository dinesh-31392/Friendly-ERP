import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from './env.js';
import type { RequestCtx } from './db.js';

export interface JwtClaims {
  sub: string;   // user id
  tid: string;   // tenant id — authoritative source of tenant identity
  rol: string;   // role name (display only; enforcement is DB-side RBAC)
  jti?: string;  // token id — the handle a single session is revoked by
  iat?: number;  // issued-at, whole seconds; compared against sessions_valid_from
}

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain).catch(() => false);
}

/**
 * @param expiresIn  jsonwebtoken lifetime. Defaults to a normal 24h session.
 *   Support logins pass something much shorter: a token that lets platform
 *   staff act inside a customer's workspace should expire on its own, not sit
 *   in a laptop's localStorage until tomorrow.
 */
export function signToken(
  claims: JwtClaims,
  expiresIn: NonNullable<jwt.SignOptions['expiresIn']> = '24h',
): string {
  // Every token gets an identity of its own. Without one there is nothing to
  // put on a deny-list, and "sign out this device" cannot be expressed —
  // only "sign out everywhere", which is a blunt answer to a common request.
  // jsonwebtoken sets `iat` itself; both are read back in withTenantContext.
  return jwt.sign({ ...claims, jti: randomUUID() }, env.jwtSecret,
    { expiresIn, issuer: 'friendly-crm' });
}

export function verifyToken(token: string): JwtClaims {
  // Pin the algorithm — never let the token choose how it is verified
  return jwt.verify(token, env.jwtSecret, { issuer: 'friendly-crm', algorithms: ['HS256'] }) as JwtClaims;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestCtx;
  }
}

/** preHandler: verifies the Bearer token and attaches the tenant context.
 *  Tenant identity comes ONLY from the signed JWT — never from headers,
 *  query params, or the request body. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    reply.code(401).send({ error: 'Missing bearer token' });
    return;
  }
  try {
    const claims = verifyToken(token);
    // Portal tokens are signed with the SAME secret and issuer as staff tokens,
    // so verifyToken accepts one happily. Today nothing bad follows, because
    // every staff route also checks a permission and a portal subject is not a
    // row in `users` — but that makes the realm boundary depend on 184 routes
    // each remembering their gate, forever. The first one added without it
    // opens the whole staff API to any customer who can log into the portal.
    // Refuse the realm here instead, where it is one check rather than 184.
    if (claims.rol?.startsWith('portal_')) {
      reply.code(401).send({ error: 'Invalid or expired token' });
      return;
    }
    req.ctx = {
      tenantId: claims.tid, userId: claims.sub, ip: req.ip,
      // Carried so withTenantContext can ask whether this exact session is
      // still live. Both are optional: a token minted before migration 037
      // has neither, and is treated as un-revoked rather than rejected, so
      // deploying revocation does not sign the whole company out at once.
      jti: claims.jti, issuedAt: claims.iat, realm: 'staff',
    };
  } catch {
    reply.code(401).send({ error: 'Invalid or expired token' });
    return;
  }
}
