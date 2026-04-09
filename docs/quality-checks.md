# SEO Quality Checks (Dashboard)

The Dashboard runs lightweight, in-memory checks for the first 50 products loaded from Shopify. These are informational and do not persist to the database.

## Checks
- Missing meta title
- Missing meta description
- Meta title over 60 characters
- Meta description over 155 characters
- Duplicate meta title (exact match, case-insensitive)
- Duplicate meta description (exact match, case-insensitive)
- Schema not applied (based on `ProductSeoData.schemaApplied`)

## Notes
- Only the first 50 products are evaluated.
- Duplicates are based on exact matches after trim + lowercasing.
- Schema coverage is based on stored `schemaApplied` state, not Shopify’s current metafield value.
