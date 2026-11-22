import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { AuthUser, Permission, ProblemDetails, ROLE_PERMISSIONS, UserRole } from '../src/shared/types';

// Ephemeral 256-bit fallback secret if PHARMASYNC_JWT_SECRET is not configured
const rawJwtSecret = process.env.PHARMASYNC_JWT_SECRET?.trim();
const JWT_SECRET =
  rawJwtSecret && rawJwtSecret !== 'undefined' && rawJwtSecret !== 'null' && rawJwtSecret.length >= 16
    ? rawJwtSecret
    : crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12 hours

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const storedBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

interface TokenPayload {
  sub: string;
  username: string;
  fullName: string;
  email: string;
  role: UserRole;
  branchId: string;
  branchName: string;
  iat: number;
  exp: number;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(base64, 'base64').toString('utf8');
}

export function signToken(user: Omit<AuthUser, 'permissions' | 'active'>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payloadObj: TokenPayload = {
    sub: user.id,
    username: user.username,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    branchId: user.branchId,
    branchName: user.branchName,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  const payload = base64UrlEncode(JSON.stringify(payloadObj));
  const signature = base64UrlEncode(
    crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${signature}`;
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const expectedSig = base64UrlEncode(
      crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest()
    );
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    const decoded = JSON.parse(base64UrlDecode(payload)) as TokenPayload;
    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return {
      id: decoded.sub,
      username: decoded.username,
      fullName: decoded.fullName,
      email: decoded.email,
      role: decoded.role,
      branchId: decoded.branchId,
      branchName: decoded.branchName,
      active: true,
      permissions: ROLE_PERMISSIONS[decoded.role] ?? [],
    };
  } catch {
    return null;
  }
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  traceId?: string;
}

export function sendProblem(
  res: Response,
  status: number,
  title: string,
  detail: string,
  errors?: Record<string, string>,
  traceId?: string
): void {
  const body: ProblemDetails = {
    type: `https://pharmasync.local/problems/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
    traceId,
    ...(errors ? { errors } : {}),
  };
  res.status(status).type('application/problem+json').json(body);
}

export function traceMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const incoming = req.header('X-Trace-Id');
  const traceId = incoming && /^[a-zA-Z0-9_-]{8,64}$/.test(incoming) ? incoming : `tr_${crypto.randomUUID().slice(0, 12)}`;
  req.traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
  next();
}

export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendProblem(res, 401, 'Unauthorized', 'Missing or malformed Bearer authentication token.', undefined, req.traceId);
    return;
  }
  const token = authHeader.slice(7).trim();
  const user = verifyToken(token);
  if (!user) {
    sendProblem(res, 401, 'Unauthorized', 'Session token is invalid or expired. Please sign in again.', undefined, req.traceId);
    return;
  }
  req.user = user;
  next();
}

export function requirePermission(permission: Permission) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendProblem(res, 401, 'Unauthorized', 'Authentication required.', undefined, req.traceId);
      return;
    }
    if (!req.user.permissions.includes(permission)) {
      sendProblem(
        res,
        403,
        'Forbidden',
        `Role ${req.user.role} lacks required permission '${permission}'.`,
        undefined,
        req.traceId
      );
      return;
    }
    next();
  };
}
