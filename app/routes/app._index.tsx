import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { useState, useEffect, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface DashProduct {
  id: string;
  title: string;
  description: string;
  productType: string;
  vendor: string;
  tags: string[];
  handle: string;
  seo: { title: string | null; description: string | null };
  featuredImage: { url: string } | null;
  variants: {
    edges: {
      node: {
        price: string;
        compareAtPrice: string | null;
        sku: string | null;
        barcode: string | null;
        availableForSale: boolean;
      };
    }[];
  };
}

interface ShopInfo {
  name: string;
  url: string;
  currencyCode: string;
}

interface BulkError {
  title: string;
  message: string;
}

interface SeoViolation {
  productId: string;
  title: string;
  type:
    | "missing_title"
    | "missing_description"
    | "title_too_long"
    | "description_too_long"
    | "duplicate_title"
    | "duplicate_description"
    | "missing_schema";
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generation helpers (inlined from meta-generator & schema-markup routes)
// ─────────────────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function generateMetaTitle(product: DashProduct): string {
  const { title, productType, vendor } = product;
  if (productType && vendor) {
    const full = `${title} - ${productType} | ${vendor}`;
    if (full.length <= 60) return full;
    const suffix = ` - ${productType} | ${vendor}`;
    const maxLen = 60 - suffix.length - 3;
    if (maxLen > 0) return `${title.slice(0, maxLen)}... | ${vendor}`;
    return `${title.slice(0, 57)}...`;
  }
  if (vendor) {
    const full = `${title} | ${vendor}`;
    if (full.length <= 60) return full;
    const suffix = ` | ${vendor}`;
    const maxLen = 60 - suffix.length - 3;
    if (maxLen > 0) return `${title.slice(0, maxLen)}... | ${vendor}`;
    return `${title.slice(0, 57)}...`;
  }
  const full = `${title} - Shop Now`;
  if (full.length <= 60) return full;
  return `${title.slice(0, 57)}...`;
}

function generateMetaDescription(product: DashProduct): string {
  const { title, vendor, productType, description } = product;
  const stripped = stripHtml(description);
  if (stripped) {
    if (stripped.length <= 155) return stripped;
    const truncated = stripped.slice(0, 152);
    const lastSpace = truncated.lastIndexOf(" ");
    return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + "...";
  }
  const parts = [
    `Shop ${title}`,
    vendor ? `by ${vendor}` : null,
    productType ? `${productType}.` : null,
    "Free shipping available. Browse our selection today.",
  ]
    .filter(Boolean)
    .join(" ");
  if (parts.length <= 155) return parts;
  return parts.slice(0, 152) + "...";
}

function generateJsonLd(product: DashProduct, shop: ShopInfo): string {
  const variants = product.variants.edges.map((e) => e.node);
  const firstVariant = variants[0] ?? null;
  const prices = variants.map((v) => parseFloat(v.price)).filter((p) => !isNaN(p));
  const lowPrice = prices.length > 0 ? Math.min(...prices) : null;
  const highPrice = prices.length > 0 ? Math.max(...prices) : null;
  const anyAvailable = variants.some((v) => v.availableForSale);
  const rawDesc = stripHtml(product.description);
  const desc = rawDesc.length > 500 ? rawDesc.slice(0, 497) + "..." : rawDesc || null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema: Record<string, any> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
  };
  if (desc) schema.description = desc;
  if (product.featuredImage?.url) schema.image = product.featuredImage.url;
  if (firstVariant?.sku) schema.sku = firstVariant.sku;
  if (firstVariant?.barcode) schema.gtin = firstVariant.barcode;
  schema.brand = { "@type": "Brand", name: product.vendor || shop.name };

  const productUrl = `${shop.url}/products/${product.handle}`;
  const availability = anyAvailable
    ? "https://schema.org/InStock"
    : "https://schema.org/OutOfStock";

  if (variants.length === 1 && firstVariant) {
    schema.offers = {
      "@type": "Offer",
      url: productUrl,
      priceCurrency: shop.currencyCode,
      price: firstVariant.price,
      availability,
    };
  } else if (lowPrice !== null && highPrice !== null) {
    schema.offers = {
      "@type": "AggregateOffer",
      url: productUrl,
      priceCurrency: shop.currencyCode,
      lowPrice: String(lowPrice),
      highPrice: String(highPrice),
      offerCount: variants.length,
      availability,
    };
  }
  return JSON.stringify(schema, null, 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const [productsResp, shopResp] = await Promise.all([
    admin.graphql(`#graphql
      {
        productsCount { count }
        products(first: 50) {
          edges {
            node {
              id title description productType vendor tags handle
              seo { title description }
              featuredImage { url }
              variants(first: 100) {
                edges {
                  node {
                    price compareAtPrice sku barcode availableForSale
                  }
                }
              }
            }
          }
        }
      }
    `),
    admin.graphql(`#graphql
      { shop { name url currencyCode } }
    `),
  ]);

  const pJson = await productsResp.json();
  const sJson = await shopResp.json();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const products: DashProduct[] = pJson.data?.products?.edges?.map((e: any) => e.node) ?? [];
  const productCount: number = pJson.data?.productsCount?.count ?? 0;
  const shop: ShopInfo = sJson.data?.shop ?? {
    name: session.shop,
    url: `https://${session.shop}`,
    currencyCode: "USD",
  };

  const productIds = products.map((p) => p.id);
  const seoRecords = await prisma.productSeoData.findMany({
    where: { shop: session.shop, productId: { in: productIds } },
  });
  const blogCount = await prisma.generatedContent.count({ where: { shop: session.shop } });
  const recentJobs = await prisma.seoJob.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const seoMap: Record<string, { applied: boolean; schemaApplied: boolean }> = {};
  for (const r of seoRecords) {
    seoMap[r.productId] = { applied: r.applied, schemaApplied: r.schemaApplied };
  }

  const withMetaTitle = products.filter((p) => !!p.seo.title).length;
  const withMetaDesc = products.filter((p) => !!p.seo.description).length;
  const withSchema = products.filter((p) => seoMap[p.id]?.schemaApplied).length;

  const total = products.length;
  const titlePct = total > 0 ? (withMetaTitle / total) * 100 : 0;
  const descPct = total > 0 ? (withMetaDesc / total) * 100 : 0;
  const schemaPct = total > 0 ? (withSchema / total) * 100 : 0;
  const healthScore = total > 0 ? Math.round((titlePct + descPct + schemaPct) / 3) : 0;

  const missingMeta = products.filter((p) => !p.seo.title || !p.seo.description);
  const missingSchema = products.filter((p) => !seoMap[p.id]?.schemaApplied);

  // ── Quality checks ──
  const violations: SeoViolation[] = [];

  const titleCounts = new Map<string, number>();
  const descCounts = new Map<string, number>();

  for (const p of products) {
    const title = p.seo.title?.trim() ?? "";
    const desc = p.seo.description?.trim() ?? "";
    if (title) titleCounts.set(title.toLowerCase(), (titleCounts.get(title.toLowerCase()) ?? 0) + 1);
    if (desc) descCounts.set(desc.toLowerCase(), (descCounts.get(desc.toLowerCase()) ?? 0) + 1);
  }

  for (const p of products) {
    const title = p.seo.title?.trim() ?? "";
    const desc = p.seo.description?.trim() ?? "";

    if (!title) {
      violations.push({
        productId: p.id,
        title: p.title,
        type: "missing_title",
        message: "Missing meta title",
      });
    } else if (title.length > 60) {
      violations.push({
        productId: p.id,
        title: p.title,
        type: "title_too_long",
        message: `Meta title too long (${title.length}/60)`,
      });
    } else if ((titleCounts.get(title.toLowerCase()) ?? 0) > 1) {
      violations.push({
        productId: p.id,
        title: p.title,
        type: "duplicate_title",
        message: "Duplicate meta title",
      });
    }

    if (!desc) {
      violations.push({
        productId: p.id,
        title: p.title,
        type: "missing_description",
        message: "Missing meta description",
      });
    } else if (desc.length > 155) {
      violations.push({
        productId: p.id,
        title: p.title,
        type: "description_too_long",
        message: `Meta description too long (${desc.length}/155)`,
      });
    } else if ((descCounts.get(desc.toLowerCase()) ?? 0) > 1) {
      violations.push({
        productId: p.id,
        title: p.title,
        type: "duplicate_description",
        message: "Duplicate meta description",
      });
    }

    if (!seoMap[p.id]?.schemaApplied) {
      violations.push({
        productId: p.id,
        title: p.title,
        type: "missing_schema",
        message: "Schema not applied",
      });
    }
  }

  const violationSummary = violations.reduce<Record<string, number>>((acc, v) => {
    acc[v.type] = (acc[v.type] ?? 0) + 1;
    return acc;
  }, {});

  return {
    products,
    shop,
    productCount,
    withMetaTitle,
    withMetaDesc,
    withSchema,
    blogCount,
    recentJobs,
    healthScore,
    missingMeta,
    missingSchema,
    violations,
    violationSummary,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Action
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCT_UPDATE_META = `#graphql
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id }
      userErrors { field message }
    }
  }`;

const PRODUCT_UPDATE_SCHEMA = `#graphql
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id }
      userErrors { field message }
    }
  }`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // ── Bulk Meta ──
  if (intent === "bulkMeta") {
    const productsJson = formData.get("productsJson") as string;
    const offset = parseInt((formData.get("offset") as string) ?? "0");
    const jobIdIn = formData.get("jobId") as string | null;
    const products: DashProduct[] = JSON.parse(productsJson);
    const batch = products.slice(offset, offset + 10);

    let job;
    if (!jobIdIn) {
      job = await prisma.seoJob.create({
        data: {
          shop: session.shop,
          status: "processing",
          jobType: "meta_generation",
          totalItems: products.length,
          processed: 0,
        },
      });
    } else {
      job = await prisma.seoJob.findUnique({ where: { id: jobIdIn } });
    }
    if (!job) return { intent: "bulkMeta", error: "Job not found" };

    const existingErrors: BulkError[] = job.errors
      ? (() => { try { return JSON.parse(job.errors); } catch { return []; } })()
      : [];
    let processed = job.processed;

    for (const product of batch) {
      try {
        const metaTitle = generateMetaTitle(product);
        const metaDescription = generateMetaDescription(product);
        const resp = await admin.graphql(PRODUCT_UPDATE_META, {
          variables: { input: { id: product.id, seo: { title: metaTitle, description: metaDescription } } },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json = await resp.json() as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gqlErrors: any[] = json.errors ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const userErrors: any[] = json.data?.productUpdate?.userErrors ?? [];

        if (gqlErrors.length > 0) {
          existingErrors.push({ title: product.title, message: gqlErrors[0].message });
        } else if (userErrors.length > 0) {
          existingErrors.push({ title: product.title, message: userErrors.map((e) => e.message).join(", ") });
        } else {
          await prisma.productSeoData.upsert({
            where: { shop_productId: { shop: session.shop, productId: product.id } },
            create: {
              shop: session.shop,
              productId: product.id,
              generatedMeta: JSON.stringify({ metaTitle, metaDescription }),
              applied: true,
            },
            update: {
              generatedMeta: JSON.stringify({ metaTitle, metaDescription }),
              applied: true,
            },
          });
        }
      } catch (e) {
        existingErrors.push({ title: product.title, message: String(e) });
      }
      processed++;
      await new Promise((r) => setTimeout(r, 200));
    }

    const done = offset + batch.length >= products.length;
    await prisma.seoJob.update({
      where: { id: job.id },
      data: {
        processed,
        status: done ? "completed" : "processing",
        errors: JSON.stringify(existingErrors),
      },
    });

    return { intent: "bulkMeta", jobId: job.id, processed, totalItems: products.length, done, errors: existingErrors };
  }

  // ── Bulk Schema ──
  if (intent === "bulkSchema") {
    const productsJson = formData.get("productsJson") as string;
    const shopJson = formData.get("shopJson") as string;
    const offset = parseInt((formData.get("offset") as string) ?? "0");
    const jobIdIn = formData.get("jobId") as string | null;
    const products: DashProduct[] = JSON.parse(productsJson);
    const shop: ShopInfo = JSON.parse(shopJson);
    const batch = products.slice(offset, offset + 10);

    let job;
    if (!jobIdIn) {
      job = await prisma.seoJob.create({
        data: {
          shop: session.shop,
          status: "processing",
          jobType: "schema_generation",
          totalItems: products.length,
          processed: 0,
        },
      });
    } else {
      job = await prisma.seoJob.findUnique({ where: { id: jobIdIn } });
    }
    if (!job) return { intent: "bulkSchema", error: "Job not found" };

    const existingErrors: BulkError[] = job.errors
      ? (() => { try { return JSON.parse(job.errors); } catch { return []; } })()
      : [];
    let processed = job.processed;

    for (const product of batch) {
      try {
        const jsonLd = generateJsonLd(product, shop);
        const resp = await admin.graphql(PRODUCT_UPDATE_SCHEMA, {
          variables: {
            input: {
              id: product.id,
              metafields: [{ namespace: "metaforge_seo", key: "json_ld", value: jsonLd, type: "json" }],
            },
          },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json = await resp.json() as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gqlErrors: any[] = json.errors ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const userErrors: any[] = json.data?.productUpdate?.userErrors ?? [];

        if (gqlErrors.length > 0) {
          existingErrors.push({ title: product.title, message: gqlErrors[0].message });
        } else if (userErrors.length > 0) {
          existingErrors.push({ title: product.title, message: userErrors.map((e) => e.message).join(", ") });
        } else {
          await prisma.productSeoData.upsert({
            where: { shop_productId: { shop: session.shop, productId: product.id } },
            create: { shop: session.shop, productId: product.id, generatedSchema: jsonLd, schemaApplied: true },
            update: { generatedSchema: jsonLd, schemaApplied: true },
          });
        }
      } catch (e) {
        existingErrors.push({ title: product.title, message: String(e) });
      }
      processed++;
      await new Promise((r) => setTimeout(r, 200));
    }

    const done = offset + batch.length >= products.length;
    await prisma.seoJob.update({
      where: { id: job.id },
      data: {
        processed,
        status: done ? "completed" : "processing",
        errors: JSON.stringify(existingErrors),
      },
    });

    return { intent: "bulkSchema", jobId: job.id, processed, totalItems: products.length, done, errors: existingErrors };
  }

  return { error: "Unknown intent" };
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function HealthScoreRing({ score }: { score: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 80 ? "#008060" : score >= 50 ? "#856404" : "#d82c0d";

  return (
    <div style={{ position: "relative", width: 140, height: 140 }}>
      <svg width={140} height={140} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={70} cy={70} r={radius} fill="none" stroke="#e1e3e5" strokeWidth={12} />
        <circle
          cx={70}
          cy={70}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={12}
          strokeDasharray={`${circumference}`}
          strokeDashoffset={`${offset}`}
          strokeLinecap="round"
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ fontSize: 32, fontWeight: 700, color, lineHeight: 1 }}>{score}%</span>
        <span style={{ fontSize: 11, color: "#6d7175", marginTop: 2 }}>SEO Health</span>
      </div>
    </div>
  );
}

function ScoreBar({ label, count, total }: { label: string; count: number; total: number }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const color = pct >= 80 ? "#008060" : pct >= 50 ? "#856404" : "#d82c0d";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
        <span style={{ color: "#3d4044" }}>{label}</span>
        <span style={{ color, fontWeight: 600 }}>
          {count}/{total} ({pct}%)
        </span>
      </div>
      <div style={{ height: 6, background: "#e1e3e5", borderRadius: 4, overflow: "hidden" }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: color,
            borderRadius: 4,
            transition: "width 0.5s ease",
          }}
        />
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color?: string;
}) {
  return (
    <div
      style={{
        background: "white",
        border: "1px solid #e1e3e5",
        borderRadius: 8,
        padding: "16px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 13, color: "#6d7175", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: color ?? "#3d4044", lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: "#8c9196", marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function BulkProgressBar({
  processed,
  total,
  jobType,
}: {
  processed: number;
  total: number;
  jobType: "meta" | "schema";
}) {
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const label = jobType === "meta" ? "Generating & applying meta tags" : "Generating & applying schema markup";
  return (
    <div
      style={{
        background: "#f0f7ff",
        border: "1px solid #c9d9f7",
        borderRadius: 8,
        padding: 16,
        marginBottom: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 13 }}>
        <span style={{ fontWeight: 600, color: "#003d9f" }}>{label}…</span>
        <span style={{ color: "#6d7175" }}>
          {processed}/{total} ({pct}%)
        </span>
      </div>
      <div style={{ height: 8, background: "#c9d9f7", borderRadius: 4, overflow: "hidden" }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "#005bd3",
            borderRadius: 4,
            transition: "width 0.4s ease",
          }}
        />
      </div>
      <div style={{ fontSize: 12, color: "#6d7175", marginTop: 6 }}>
        Processing in batches of 10 — please keep this page open…
      </div>
    </div>
  );
}

function formatJobType(t: string): string {
  if (t === "meta_generation") return "Meta Tags";
  if (t === "schema_generation") return "Schema Markup";
  if (t === "blog_generation") return "Blog Post";
  return t;
}

function formatJobStatus(s: string): { label: string; bg: string; color: string } {
  if (s === "completed") return { label: "Completed", bg: "#d4edda", color: "#155724" };
  if (s === "processing") return { label: "Processing", bg: "#fff3cd", color: "#856404" };
  if (s === "failed") return { label: "Failed", bg: "#f8d7da", color: "#721c24" };
  return { label: "Pending", bg: "#f6f6f7", color: "#6d7175" };
}

const BTN_PRIMARY: React.CSSProperties = {
  padding: "8px 16px",
  background: "#005bd3",
  color: "white",
  border: "none",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
};

const BTN_SUCCESS: React.CSSProperties = {
  ...BTN_PRIMARY,
  background: "#008060",
};

const BTN_DISABLED: React.CSSProperties = {
  ...BTN_PRIMARY,
  background: "#f1f1f1",
  color: "#8c9196",
  cursor: "not-allowed",
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const {
    products,
    shop,
    productCount,
    withMetaTitle,
    withMetaDesc,
    withSchema,
    blogCount,
    recentJobs,
    healthScore,
    missingMeta,
    missingSchema,
    violations,
    violationSummary,
  } = useLoaderData<typeof loader>();

  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();

  const [bulkState, setBulkState] = useState<{
    jobId?: string;
    jobType: "meta" | "schema";
    offset: number;
    processed: number;
    totalItems: number;
    productsJson: string;
  } | null>(null);

  const [bulkErrors, setBulkErrors] = useState<BulkError[]>([]);
  const [showBulkErrors, setShowBulkErrors] = useState(false);
  const [bulkDone, setBulkDone] = useState<"meta" | "schema" | null>(null);

  // Track last submitted offset to prevent duplicate submissions
  const submittedOffsetRef = useRef<number>(-1);

  const isBulkRunning = bulkState !== null || fetcher.state !== "idle";

  // ── Chain: submit next batch when fetcher is idle and there's more to process ──
  useEffect(() => {
    if (!bulkState) {
      submittedOffsetRef.current = -1;
      return;
    }
    if (fetcher.state !== "idle") return;
    if (bulkState.offset === submittedOffsetRef.current) return;
    if (bulkState.processed >= bulkState.totalItems) return;

    submittedOffsetRef.current = bulkState.offset;

    const fd = new FormData();
    fd.set("intent", bulkState.jobType === "meta" ? "bulkMeta" : "bulkSchema");
    if (bulkState.jobId) fd.set("jobId", bulkState.jobId);
    fd.set("offset", String(bulkState.offset));
    fd.set("productsJson", bulkState.productsJson);
    if (bulkState.jobType === "schema") {
      fd.set("shopJson", JSON.stringify(shop));
    }
    fetcher.submit(fd, { method: "post" });
  }, [bulkState?.offset, fetcher.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handle fetcher results ──
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = fetcher.data as any;
    if (!data) return;

    const isRelevant = data.intent === "bulkMeta" || data.intent === "bulkSchema";
    if (!isRelevant) return;

    if (data.error) {
      setBulkState(null);
      return;
    }

    const { jobId, processed, done, errors } = data;

    if (errors?.length) {
      setBulkErrors((prev) => [...prev, ...errors]);
      setShowBulkErrors(true);
    }

    if (done) {
      setBulkDone(data.intent === "bulkMeta" ? "meta" : "schema");
      setBulkState(null);
      revalidator.revalidate();
    } else {
      setBulkState((prev) =>
        prev ? { ...prev, jobId, processed, offset: processed } : null,
      );
    }
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  function startBulk(jobType: "meta" | "schema") {
    const targets = jobType === "meta" ? missingMeta : missingSchema;
    if (targets.length === 0) return;
    setBulkErrors([]);
    setBulkDone(null);
    setShowBulkErrors(false);
    submittedOffsetRef.current = -1;
    setBulkState({
      jobType,
      offset: 0,
      processed: 0,
      totalItems: targets.length,
      productsJson: JSON.stringify(targets),
    });
  }

  const scoreColor =
    healthScore >= 80 ? "#008060" : healthScore >= 50 ? "#856404" : "#d82c0d";

  // Estimate progress during an in-flight batch (adds up to 10 to look responsive)
  const displayProcessed =
    bulkState && fetcher.state !== "idle"
      ? Math.min(
          bulkState.processed + Math.min(10, bulkState.totalItems - bulkState.processed),
          bulkState.totalItems,
        )
      : bulkState?.processed ?? 0;

  return (
    <s-page heading="MetaForge SEO — Dashboard">

      {/* ── Error banner ── */}
      {showBulkErrors && bulkErrors.length > 0 && (
        <s-section>
          <div
            style={{
              padding: "12px 16px",
              background: "#fff3cd",
              color: "#856404",
              borderRadius: 8,
              fontSize: 14,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <span>
                ⚠ {bulkErrors.length} product{bulkErrors.length !== 1 ? "s" : ""} encountered
                errors during bulk generation:
              </span>
              <button
                onClick={() => setShowBulkErrors(false)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 18,
                  color: "#856404",
                  lineHeight: 1,
                  padding: "0 4px",
                }}
              >
                ✕
              </button>
            </div>
            <ul style={{ margin: "8px 0 0", paddingLeft: 20, fontSize: 13 }}>
              {bulkErrors.slice(0, 5).map((e, i) => (
                <li key={i}>
                  {e.title}: {e.message}
                </li>
              ))}
              {bulkErrors.length > 5 && <li>…and {bulkErrors.length - 5} more</li>}
            </ul>
          </div>
        </s-section>
      )}

      {/* ── Success banner ── */}
      {bulkDone && !isBulkRunning && (
        <s-section>
          <div
            style={{
              padding: "12px 16px",
              background: "#d4edda",
              color: "#155724",
              borderRadius: 8,
              fontSize: 14,
            }}
          >
            ✓ Bulk {bulkDone === "meta" ? "meta tag" : "schema markup"} generation complete!
            {bulkErrors.length > 0
              ? ` (${bulkErrors.length} error${bulkErrors.length !== 1 ? "s" : ""} — see above)`
              : " All products updated successfully."}
          </div>
        </s-section>
      )}

      {/* ── Empty state ── */}
      {products.length === 0 && (
        <s-section>
          <div
            style={{
              padding: "32px 16px",
              background: "#f6f6f7",
              borderRadius: 8,
              textAlign: "center",
              color: "#6d7175",
              fontSize: 14,
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 8 }}>📦</div>
            <div style={{ fontWeight: 600, fontSize: 16, color: "#3d4044", marginBottom: 4 }}>
              No products found
            </div>
            <div>Add products to your Shopify store to start generating SEO content.</div>
          </div>
        </s-section>
      )}

      {/* ── SEO Health Overview ── */}
      {products.length > 0 && (
        <s-section heading="SEO Health Overview">
          <div style={{ display: "flex", gap: 32, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <HealthScoreRing score={healthScore} />
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: scoreColor }}>
                  {healthScore >= 80 ? "Good" : healthScore >= 50 ? "Needs Work" : "Critical"}
                </div>
                <div style={{ fontSize: 12, color: "#8c9196" }}>
                  Based on first 50 products
                </div>
              </div>
            </div>

            <div style={{ flex: 1, minWidth: 200, display: "flex", flexDirection: "column", gap: 14 }}>
              <ScoreBar label="Meta Titles" count={withMetaTitle} total={products.length} />
              <ScoreBar label="Meta Descriptions" count={withMetaDesc} total={products.length} />
              <ScoreBar label="Schema Markup" count={withSchema} total={products.length} />
            </div>
          </div>
        </s-section>
      )}

      {/* ── Stats ── */}
      {products.length > 0 && (
        <s-section heading="Store Overview">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 16,
            }}
          >
            <StatCard
              label="Total Products"
              value={String(productCount)}
              sub="in your store"
            />
            <StatCard
              label="Meta Tags"
              value={`${withMetaTitle}/${products.length}`}
              sub={`${products.length > 0 ? Math.round((withMetaTitle / products.length) * 100) : 0}% have titles`}
              color="#005bd3"
            />
            <StatCard
              label="Schema Markup"
              value={`${withSchema}/${products.length}`}
              sub={`${products.length > 0 ? Math.round((withSchema / products.length) * 100) : 0}% applied`}
              color="#008060"
            />
            <StatCard
              label="Blog Posts"
              value={String(blogCount)}
              sub="AI-generated"
              color="#856404"
            />
          </div>
        </s-section>
      )}

      {/* ── Bulk Operations ── */}
      <s-section heading="Bulk Operations">
        <s-stack direction="block" gap="base">
          {isBulkRunning && bulkState && (
            <BulkProgressBar
              processed={displayProcessed}
              total={bulkState.totalItems}
              jobType={bulkState.jobType}
            />
          )}

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button
              onClick={() => startBulk("meta")}
              disabled={isBulkRunning || missingMeta.length === 0}
              style={
                isBulkRunning || missingMeta.length === 0
                  ? BTN_DISABLED
                  : BTN_PRIMARY
              }
            >
              {isBulkRunning && bulkState?.jobType === "meta"
                ? `Generating… (${bulkState.processed}/${bulkState.totalItems})`
                : missingMeta.length === 0
                ? "All Meta Tags Set ✓"
                : `Generate All Missing Meta (${missingMeta.length})`}
            </button>

            <button
              onClick={() => startBulk("schema")}
              disabled={isBulkRunning || missingSchema.length === 0}
              style={
                isBulkRunning || missingSchema.length === 0
                  ? BTN_DISABLED
                  : BTN_SUCCESS
              }
            >
              {isBulkRunning && bulkState?.jobType === "schema"
                ? `Generating… (${bulkState.processed}/${bulkState.totalItems})`
                : missingSchema.length === 0
                ? "All Schema Applied ✓"
                : `Generate All Schema (${missingSchema.length})`}
            </button>

            <a
              href="/app/blog-generator"
              style={{
                padding: "8px 16px",
                border: "1px solid #c9cccf",
                borderRadius: 6,
                fontSize: 14,
                color: "#3d4044",
                textDecoration: "none",
                fontWeight: 500,
              }}
            >
              View Blog Posts →
            </a>
          </div>

          {products.length > 0 && (
            <div style={{ fontSize: 13, color: "#6d7175" }}>
              {missingMeta.length > 0 && (
                <span>
                  {missingMeta.length} product{missingMeta.length !== 1 ? "s" : ""} missing
                  meta tags.{" "}
                </span>
              )}
              {missingSchema.length > 0 && (
                <span>
                  {missingSchema.length} product{missingSchema.length !== 1 ? "s" : ""} without
                  schema markup.
                </span>
              )}
              {missingMeta.length === 0 && missingSchema.length === 0 && (
                <span style={{ color: "#008060" }}>
                  ✓ All products are fully optimized!
                </span>
              )}
            </div>
          )}
        </s-stack>
      </s-section>

      {/* ── Recent Activity ── */}
      <s-section heading="Recent Activity">
        {recentJobs.length === 0 ? (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              color: "#8c9196",
              background: "#f6f6f7",
              borderRadius: 8,
              fontSize: 14,
            }}
          >
            No bulk operations yet. Use the buttons above to get started.
          </div>
        ) : (
          <div style={{ border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 110px 130px 90px 160px",
                gap: 12,
                padding: "10px 16px",
                background: "#f6f6f7",
                fontWeight: 600,
                fontSize: 13,
                color: "#3d4044",
                borderBottom: "1px solid #e1e3e5",
              }}
            >
              <span>Type</span>
              <span>Status</span>
              <span>Progress</span>
              <span>Errors</span>
              <span>Date</span>
            </div>

            {recentJobs.map((job: (typeof recentJobs)[0], idx: number) => {
              const js = formatJobStatus(job.status);
              const errCount = job.errors
                ? (() => { try { return (JSON.parse(job.errors) as unknown[]).length; } catch { return 0; } })()
                : 0;

              return (
                <div
                  key={job.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 110px 130px 90px 160px",
                    gap: 12,
                    padding: "10px 16px",
                    borderBottom: idx < recentJobs.length - 1 ? "1px solid #e1e3e5" : "none",
                    alignItems: "center",
                    background: "white",
                  }}
                >
                  <span style={{ fontSize: 13, color: "#3d4044" }}>
                    {formatJobType(job.jobType)}
                  </span>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: js.bg,
                      color: js.color,
                      fontSize: 12,
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {js.label}
                  </span>
                  <span style={{ fontSize: 13, color: "#6d7175" }}>
                    {job.totalItems > 0 ? `${job.processed} / ${job.totalItems}` : "—"}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      color: errCount > 0 ? "#d82c0d" : "#6d7175",
                    }}
                  >
                    {errCount > 0 ? `${errCount} error${errCount !== 1 ? "s" : ""}` : "—"}
                  </span>
                  <span style={{ fontSize: 12, color: "#8c9196" }}>
                    {new Date(job.createdAt).toLocaleDateString()}{" "}
                    {new Date(job.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </s-section>

      {/* ── Quality Checks ── */}
      <s-section heading="Quality Checks">
        {violations.length === 0 ? (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              color: "#8c9196",
              background: "#f6f6f7",
              borderRadius: 8,
              fontSize: 14,
            }}
          >
            No issues found in the first 50 products.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <div
              style={{
                padding: "12px 16px",
                background: "#fff3cd",
                color: "#856404",
                borderRadius: 8,
                fontSize: 13,
              }}
            >
              {violations.length} total issue{violations.length !== 1 ? "s" : ""} across the first 50 products.
              {Object.keys(violationSummary).length > 0 && (
                <span>
                  {" "}Top issues:{" "}
                  {Object.entries(violationSummary)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3)
                    .map(([k, v]) => `${k.replace(/_/g, " ")} (${v})`)
                    .join(", ")}
                </span>
              )}
            </div>

            <div style={{ border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 220px 140px 120px",
                  gap: 12,
                  padding: "10px 16px",
                  background: "#f6f6f7",
                  fontWeight: 600,
                  fontSize: 13,
                  color: "#3d4044",
                  borderBottom: "1px solid #e1e3e5",
                }}
              >
                <span>Product</span>
                <span>Issue</span>
                <span>Type</span>
                <span>Action</span>
              </div>

              {violations.slice(0, 20).map((v, idx) => (
                <div
                  key={`${v.productId}-${v.type}-${idx}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 220px 140px 120px",
                    gap: 12,
                    padding: "10px 16px",
                    borderBottom: idx < Math.min(violations.length, 20) - 1 ? "1px solid #e1e3e5" : "none",
                    alignItems: "center",
                    background: "white",
                  }}
                >
                  <span style={{ fontSize: 13, color: "#3d4044" }}>{v.title}</span>
                  <span style={{ fontSize: 13, color: "#6d7175" }}>{v.message}</span>
                  <span style={{ fontSize: 12, color: "#8c9196" }}>{v.type.replace(/_/g, " ")}</span>
                  <a
                    href={
                      v.type === "missing_schema"
                        ? "/app/schema-markup"
                        : "/app/meta-generator"
                    }
                    style={{
                      fontSize: 12,
                      color: "#2c6ecb",
                      textDecoration: "underline",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Fix →
                  </a>
                </div>
              ))}
            </div>

            {violations.length > 20 && (
              <div style={{ fontSize: 12, color: "#6d7175" }}>
                Showing 20 of {violations.length} issues. Resolve the top items first.
              </div>
            )}
          </div>
        )}
      </s-section>

      {/* ── Aside: Quick Actions ── */}
      <s-section slot="aside" heading="Quick Actions">
        <s-stack direction="block" gap="base">
          <s-button href="/app/meta-generator" variant="primary">
            Meta Generator
          </s-button>
          <s-button href="/app/schema-markup">
            Schema Markup
          </s-button>
          <s-button href="/app/approval-queue">
            Approval Queue
          </s-button>
          <s-button href="/app/blog-generator">
            Blog Generator
          </s-button>
          <s-button href="/app/settings">
            Settings
          </s-button>
        </s-stack>
      </s-section>

      {/* ── Aside: About ── */}
      <s-section slot="aside" heading="About MetaForge SEO">
        <s-unordered-list>
          <s-list-item>AI-generated meta titles &amp; descriptions</s-list-item>
          <s-list-item>JSON-LD structured data (schema.org)</s-list-item>
          <s-list-item>AI blog post generation (Claude)</s-list-item>
          <s-list-item>Bulk operations for large catalogs</s-list-item>
        </s-unordered-list>
      </s-section>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
