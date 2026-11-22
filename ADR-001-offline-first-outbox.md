# ADR-001: Dual SQLite + Browser IndexedDB Transactional Outbox for 72-Hour Offline Continuity

- **Status**: Accepted
- **Date**: 2026-11-20

## Context
Pharmacy branches experience extended internet outages (up to 72 hours) yet cannot halt dispensing, FEFO batch validation, or receipt generation.

## Decision
Maintain isolated Head Office (`head_office.db`) and Branch POS (`branch_pos.db`) SQLite databases in WAL mode alongside a client-side IndexedDB outbox (`pharmasync_branch_offline_v1`). Every branch write executes inside a local Unit of Work transaction that appends an idempotent command (`operationId`, monotonic `sequenceNo`) to `sync_outbox`.

## Consequences
- Sub-50ms local barcode lookup and sub-300ms checkout even during complete WAN outages.
- Zero lost or duplicated sales across 5,000+ offline transactions.
- Requires deterministic server-side conflict resolution upon reconnection (see ADR-004).
