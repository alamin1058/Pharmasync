# ADR-004: Deterministic Conflict Resolution During Bidirectional Sync

- **Status**: Accepted
- **Date**: 2026-11-20

## Context
During offline periods, Head Office may update selling prices, issue safety recalls, or process concurrent branch transfers while a branch continues selling from local stock.

## Decision
Apply four deterministic, non-destructive resolution rules inside `evaluateSyncConflicts`:
1. **Duplicate Operation ID**: Check `sync_acks` and safely ignore duplicate replay without double-deducting inventory.
2. **Old Price Sale**: Preserve the original fiscal POS sale price and log the variance to `conflicts`.
3. **Negative Stock After Sync**: Clamp sellable stock safely and auto-generate an `OPEN` physical `stock_count_tasks` entry for the branch.
4. **Offline Post-Recall Sale**: Compare `sale.createdAt >= batch.recalledAt` and raise a `CRITICAL` pharmacovigilance alert for immediate patient outreach.

## Consequences
- Sync never overwrites whole rows destructively and converges deterministically across multi-branch chaos scenarios (QA2).
