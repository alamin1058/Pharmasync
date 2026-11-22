# ADR-002: Mandatory FEFO Allocation & Hard Expiry/Recall Guards

- **Status**: Accepted
- **Date**: 2026-11-20

## Context
Dispensing expired or recalled medication poses severe clinical harm and regulatory liability. Manual batch picking leads to human error under retail queue pressure.

## Decision
Implement a pure `FefoBatchSelectionStrategy` shared by both client preview and server commit paths. All batches are evaluated against current date and recall metadata (`evaluateBatchStatus`). `EXPIRED` and `RECALLED` lots are filtered out unconditionally before sorting remaining sellable lots by ascending `expiryDate`.

## Consequences
- Guarantees zero expired batch sales and zero post-sync recalled batch sales (QA4).
- Multi-batch orders automatically split cleanly across earliest-expiring lots.
