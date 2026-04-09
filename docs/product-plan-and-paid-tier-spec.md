# MetaForge SEO — Prioritized Product Plan + Paid-Tier Spec (V1)

## Goals (Why This Exists)
- Prove measurable SEO impact (CTR, impressions, query coverage).
- Reduce labor through automation with safe controls.
- Enable paid conversion with clear, defensible ROI.

## Target Users
- Product-heavy Shopify stores (hundreds to thousands of SKUs).
- Agencies managing multiple stores (later phase).

## Prioritized Product Plan (Now -> Next -> Later)

### P0 (0–4 weeks): Paid Tier V1 — Value Proof + Automation
1) Google Search Console (GSC) integration + impact dashboard  
2) Automation rules for missing SEO (meta/schema)  
3) Duplicate/QA validation engine (policy checks)  

### P1 (4–8 weeks): Coverage Expansion
- Collections + Pages SEO management (title/desc + JSON-LD)
- BreadcrumbList + Organization schema types
- Change history + rollback for applied SEO

### P2 (8–12 weeks): Keyword Intelligence
- Keyword suggestions per product/category
- Keyword-to-page mapping and tracking
- CTR improvement experiments (A/B on meta titles)

### P3 (12+ weeks): Agency & Growth Features
- Multi-store view, client reports, scheduled audits
- Competitor benchmarking
- Localization/hreflang workflows

## Paid Tier V1 — Detailed Specs

### 1) Google Search Console Integration + Impact Dashboard
**Purpose**: Tie SEO actions to measurable results so users can justify paying.

**User Stories**
- As a merchant, I can connect my Google Search Console account.
- As a merchant, I can see impressions/clicks/CTR by product page.
- As a merchant, I can compare “optimized vs not optimized” performance.

**UX**
- Settings: “Connect Google Search Console” button with OAuth.
- Dashboard: new “SEO Impact” section with charts:
  - CTR trend (last 28 days)
  - Impressions trend
  - Top queries for products
  - Optimized vs Not Optimized comparison

**Data Sources**
- GSC Search Analytics API: query metrics by URL.
- Shopify product URLs (`https://{shop}/products/{handle}`).

**Implementation Outline**
- OAuth flow (Google) and token storage per shop.
- Scheduled job (daily) to fetch last 28 days of metrics.
- Store metrics by productId + date.

**Data Model Additions**
- `GscAccount`: shop, accessToken, refreshToken, scope, expiresAt
- `GscMetrics`: shop, productId, date, clicks, impressions, ctr, position

**MVP Acceptance**
- OAuth connection works and refreshes tokens.
- Daily metrics populate for at least 50 products.
- Dashboard shows charts with non-zero data.

**Metrics to Track**
- % of active shops connected to GSC.
- “Impact view” weekly active usage.
- CTR change after meta/schema apply.

---

### 2) Automation Rules (Paid Tier Core)
**Purpose**: Save time by auto-fixing SEO coverage.

**User Stories**
- As a merchant, I can auto-generate meta tags for new products.
- As a merchant, I can schedule weekly runs for missing meta/schema.
- As a merchant, I can review changes before apply.

**Rules (V1)**
- Rule A: “On Product Create” -> generate meta (AI if key exists, otherwise template).
- Rule B: “Weekly” -> generate missing meta + schema.
- Rule C: “Auto-apply” toggle (default off) with approval queue.

**UX**
- New “Automation” section in Settings.
- Rule cards with toggles and last run status.
- Approval queue page with diff previews and “Apply / Skip”.

**Implementation Outline**
- Webhook: `products/create` triggers generation job.
- Scheduled job (cron) for weekly runs.
- Store pending changes in DB with status.

**Data Model Additions**
- `AutomationRule`: shop, type, enabled, schedule, autoApply
- `SeoChangeQueue`: shop, productId, changeType, payload, status, createdAt

**MVP Acceptance**
- Product create triggers meta generation.
- Weekly run generates missing meta/schema and queues changes.
- Approval queue allows apply/skip with persisted status.

**Metrics to Track**
- % of SEO coverage auto-fixed per week.
- Average time from generate -> apply.

---

### 3) Duplicate + QA Validation Engine
**Purpose**: Prevent SEO regressions and enforce quality.

**User Stories**
- As a merchant, I can detect duplicate meta titles or descriptions.
- As a merchant, I can enforce length constraints.
- As a merchant, I can see a “Policy Violations” list.

**Checks (V1)**
- Duplicate meta title (exact match)
- Duplicate meta description (exact match)
- Title length > 60
- Description length > 155
- Empty meta fields
- Schema missing key fields (name, offers)

**UX**
- Dashboard: “Policy Violations” badge with count.
- Dedicated “Quality Checks” page or section in Dashboard.

**Implementation Outline**
- Daily job scans `ProductSeoData` + Shopify SEO fields.
- Stores violations per product and check type.

**Data Model Additions**
- `SeoViolation`: shop, productId, type, message, createdAt, resolvedAt

**MVP Acceptance**
- Violations list populates and is visible.
- Users can click to navigate to product edit.

**Metrics to Track**
- Violations reduced over time.
- User engagement with QA view.

---

## Release Plan (Paid Tier V1)
**Week 1–2**
- Add GSC OAuth + token storage.
- Set up daily metrics sync job.

**Week 3–4**
- Build Impact dashboard UI.
- Add Automation rules (product create + weekly).
- Add approval queue + policy checks.

**Week 5**
- Beta with 5–10 stores.
- Collect CTR uplift data for paid conversion.

## Risks & Mitigations
- GSC OAuth complexity: start with manual verification and limited scopes.
- Long-running jobs: batch + queue with throttling.
- Shopify rate limits: delay between mutations (existing pattern).

## Paid Tier Positioning
- Message: “We show you what actually improved and automate the rest.”
- Pricing anchor: $79–129/month (tied to GSC reporting + automation).
