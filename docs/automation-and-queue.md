# Automation + Approval Queue

## Overview
Automation rules enqueue SEO changes for review or auto-apply them when run manually. This system is intended to reduce manual work and keep SEO coverage up to date.

## Rules
- `product_create_meta`: when a product is created, enqueue meta tag generation
- `product_create_schema`: when a product is created, enqueue schema generation
- `weekly_meta`: placeholder for scheduled runs (manual “Run Now” uses this logic)
- `weekly_schema`: placeholder for scheduled runs (manual “Run Now” uses this logic)

Rules are stored in `AutomationRule` and are per-shop.

## Approval Queue
Changes are stored in `SeoChangeQueue` with statuses:
- `pending`: waiting for review
- `applied`: successfully applied to Shopify
- `skipped`: explicitly skipped
- `failed`: error applying

Queue UI lives at `/app/approval-queue` and allows apply/skip.

## Current Behavior
- Product create webhook enqueues changes (no auto-apply in webhook context).
- “Run Now” in Settings can optionally auto-apply changes and records them as `applied`.
- Queue currently uses first 50 products for “Run Now”.

## Next Improvements
- Scheduled job runner for weekly rules.
- Auto-apply in webhook context using offline tokens.
- Queue detail view and per-item diffs.
