# MetaForge SEO — Competitive Gaps & Paid-Value Roadmap

## Competitive Gaps (What Established Apps Usually Offer)
- Keyword intelligence: research, clustering, difficulty, and opportunity scoring.
- Search Console integration: impressions, clicks, CTR, and query/page visibility.
- Full site coverage: collections, pages, and technical SEO checks beyond products.
- Change tracking: history, diffs, approvals, and rollback.
- Automation rules: schedules, triggers, and “auto-apply” workflows.
- International SEO: hreflang, multi-market meta, and translation workflows.
- QA/validation: length checks, duplicate detection, and policy enforcement.
- ROI reporting: before/after CTR and traffic trends tied to applied changes.

## What Makes This Paid-Worthy
- A closed-loop workflow: detect opportunity -> generate -> apply safely -> measure impact.
- Automated coverage for large catalogs (new product triggers, weekly fixes).
- Trust and control: approvals, diff previews, and rollback.
- Measurable outcomes: CTR/impressions improvements and SEO health trends.

## High-Leverage Roadmap (Pragmatic Sequence)

### 1) Coverage + QA (Foundation)
- Add collection and page SEO management (title/description + JSON-LD).
- Add schema types: BreadcrumbList + Organization (plus Article/BlogPosting).
- Duplicate/near-duplicate detection for meta titles/descriptions.
- Validation rules: length, empties, keyword stuffing, and template collisions.

### 2) Search Console + Reporting (Proof of Value)
- OAuth to Google Search Console.
- Page/query dashboards for impressions, clicks, CTR, position.
- “Optimized vs. not optimized” comparison charts.

### 3) Automation + Safe Apply (Time Savings)
- Auto-generate for new products on create.
- Scheduled runs (nightly/weekly) for missing meta/schema.
- Approval queue with preview diffs and rollback.

### 4) Keyword Intelligence (Revenue Engine)
- Suggest keywords by product/category.
- Map target keyword -> product.
- Track CTR/position changes post-apply.

## Packaging & Pricing (Positioning)

### Starter ($19–39/mo)
- Meta + schema generation
- Bulk tools and previews
- Basic SEO health dashboard

### Pro ($79–129/mo)
- Search Console integration
- Automation rules
- Duplicate detection + validations
- Weekly SEO reporting

### Agency ($249+/mo)
- Multi-store support
- Client reports & exports
- Campaign templates and scheduled audits

## Retention Drivers
- Weekly “wins” email: CTR and keyword movement.
- Automated issue alerts: “X products missing meta.”
- Competitive benchmarks (optional) for top competitors.

## Risks and Constraints to Resolve
- Product coverage: current UI routes only load first 50 products.
- API versions: Admin API (2025-10) vs webhook API (2026-04) should be aligned.
- Theme integration: ensure JSON metafield uses `.value` in Liquid.

## Assumptions
- Primary customers are product-heavy stores and agencies.
- Value is measured primarily via CTR and search impressions.
