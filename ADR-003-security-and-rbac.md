# ADR-003: Server-Side Scrypt Hashing, In-Memory JWT Bearer Tokens & 6-Role RBAC

- **Status**: Accepted
- **Date**: 2026-11-20

## Context
PharmaSync serves six distinct staff personas (Super Admin, Head Office Admin, Branch Manager, Pharmacist, Cashier, Inventory Staff) handling regulated prescription records and financial pricing.

## Decision
- Hash all staff passwords server-side with `crypto.scryptSync` and unique 16-byte per-user salts, verified via `crypto.timingSafeEqual`.
- Sign short-lived HMAC-SHA256 JWT tokens kept strictly in client memory (`Authorization: Bearer`) rather than `localStorage`.
- Enforce granular permission middleware (`requirePermission`) on every protected `/api/*` endpoint.
- Use a one-time atomic First-Run Admin Claim bootstrap route (`/api/auth/bootstrap`) when `PHARMASYNC_ADMIN_PASSWORD` is unset.

## Consequences
- Eliminates XSS token theft vectors associated with web storage.
- Prevents privilege escalation (e.g., cashiers cannot modify central prices or issue recalls).
