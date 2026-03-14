import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { useState, useRef, useEffect } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShopifyProduct {
  id: string;
  title: string;
  description: string;
  productType: string;
  vendor: string;
  tags: string[];
  seo: { title: string | null; description: string | null };
  featuredImage: { url: string } | null;
  variants: { edges: { node: { price: string } }[] };
}

interface GeneratedSeoItem {
  productId: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
}

// ---------------------------------------------------------------------------
// Generation helpers (deterministic / template-based)
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function generateMetaTitle(product: ShopifyProduct): string {
  const { title, productType, vendor } = product;

  if (productType && vendor) {
    const full = `${title} - ${productType} | ${vendor}`;
    if (full.length <= 60) return full;
    const suffix = ` - ${productType} | ${vendor}`;
    const maxTitleLen = 60 - suffix.length - 3;
    if (maxTitleLen > 0) return `${title.slice(0, maxTitleLen)}... | ${vendor}`;
    return `${title.slice(0, 57)}...`;
  }

  if (vendor) {
    const full = `${title} | ${vendor}`;
    if (full.length <= 60) return full;
    const suffix = ` | ${vendor}`;
    const maxTitleLen = 60 - suffix.length - 3;
    if (maxTitleLen > 0) return `${title.slice(0, maxTitleLen)}... | ${vendor}`;
    return `${title.slice(0, 57)}...`;
  }

  const full = `${title} - Shop Now`;
  if (full.length <= 60) return full;
  return `${title.slice(0, 57)}...`;
}

function generateMetaDescription(product: ShopifyProduct): string {
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

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const response = await admin.graphql(`#graphql
    {
      products(first: 50) {
        edges {
          node {
            id
            title
            description
            productType
            vendor
            tags
            seo {
              title
              description
            }
            featuredImage {
              url
            }
            variants(first: 1) {
              edges {
                node {
                  price
                }
              }
            }
          }
        }
      }
    }
  `);

  const json = await response.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const products: ShopifyProduct[] = json.data?.products?.edges?.map((e: any) => e.node) ?? [];

  const productIds = products.map((p) => p.id);
  const seoRecords = await prisma.productSeoData.findMany({
    where: { shop: session.shop, productId: { in: productIds } },
  });

  // Map productId → { applied, generatedMeta }
  const seoMap: Record<string, { applied: boolean }> = {};
  for (const r of seoRecords) {
    seoMap[r.productId] = { applied: r.applied };
  }

  return { products, seoMap, shop: session.shop };
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // ── Generate ──
  if (intent === "generate") {
    const productIds = new Set(formData.getAll("productId") as string[]);
    const productsJson = formData.get("productsJson") as string;
    const products: ShopifyProduct[] = JSON.parse(productsJson).filter(
      (p: ShopifyProduct) => productIds.has(p.id),
    );

    const generated: GeneratedSeoItem[] = products.map((product) => ({
      productId: product.id,
      title: product.title,
      metaTitle: generateMetaTitle(product),
      metaDescription: generateMetaDescription(product),
    }));

    for (const item of generated) {
      await prisma.productSeoData.upsert({
        where: { shop_productId: { shop: session.shop, productId: item.productId } },
        create: {
          shop: session.shop,
          productId: item.productId,
          generatedMeta: JSON.stringify({
            metaTitle: item.metaTitle,
            metaDescription: item.metaDescription,
          }),
          applied: false,
        },
        update: {
          generatedMeta: JSON.stringify({
            metaTitle: item.metaTitle,
            metaDescription: item.metaDescription,
          }),
          applied: false,
        },
      });
    }

    return { intent: "generate", generated };
  }

  // ── Apply ──
  if (intent === "apply") {
    const itemsJson = formData.get("itemsJson") as string;
    const items: GeneratedSeoItem[] = JSON.parse(itemsJson);

    let applied = 0;
    const errors: { title: string; message: string }[] = [];

    for (const item of items) {
      try {
        const resp = await admin.graphql(
          `#graphql
          mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              product {
                id
                seo { title description }
              }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              input: {
                id: item.productId,
                seo: { title: item.metaTitle, description: item.metaDescription },
              },
            },
          },
        );

        const respJson = await resp.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const userErrors: any[] = respJson.data?.productUpdate?.userErrors ?? [];

        if (userErrors.length > 0) {
          errors.push({
            title: item.title,
            message: userErrors.map((e) => e.message).join(", "),
          });
        } else {
          applied++;
          await prisma.productSeoData.update({
            where: { shop_productId: { shop: session.shop, productId: item.productId } },
            data: { applied: true },
          });
        }

        // Avoid hitting Shopify rate limits
        await new Promise((r) => setTimeout(r, 200));
      } catch (e) {
        errors.push({ title: item.title, message: String(e) });
      }
    }

    return { intent: "apply", applied, errors };
  }

  return { error: "Unknown intent" };
};

// ---------------------------------------------------------------------------
// Indeterminate checkbox helper
// ---------------------------------------------------------------------------

function IndeterminateCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      style={{ cursor: "pointer", width: 16, height: 16 }}
    />
  );
}

// ---------------------------------------------------------------------------
// Shared card style
// ---------------------------------------------------------------------------

const CARD_STYLE: React.CSSProperties = {
  background: "white",
  border: "1px solid #e1e3e5",
  borderRadius: 8,
  padding: "16px",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MetaGenerator() {
  const { products, seoMap } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<
    Record<string, { metaTitle?: string; metaDescription?: string }>
  >({});

  const isGenerating =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "generate";
  const isApplying =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "apply";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetcherData = fetcher.data as any;
  const generatedItems: GeneratedSeoItem[] | null =
    fetcherData?.intent === "generate" ? fetcherData.generated : null;
  const applyResult =
    fetcherData?.intent === "apply"
      ? {
          applied: fetcherData.applied as number,
          errors: fetcherData.errors as { title: string; message: string }[],
        }
      : null;

  // Merge server output with in-page edits
  const displayItems: GeneratedSeoItem[] = (generatedItems ?? []).map((item) => ({
    ...item,
    metaTitle: edits[item.productId]?.metaTitle ?? item.metaTitle,
    metaDescription: edits[item.productId]?.metaDescription ?? item.metaDescription,
  }));

  const allSelected = products.length > 0 && selected.size === products.length;
  const someSelected = selected.size > 0 && !allSelected;

  function toggleAll() {
    if (allSelected || someSelected) setSelected(new Set());
    else setSelected(new Set(products.map((p) => p.id)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function seoStatus(product: ShopifyProduct): "complete" | "partial" | "missing" {
    const hasTitle = !!product.seo.title;
    const hasDesc = !!product.seo.description;
    if (hasTitle && hasDesc) return "complete";
    if (hasTitle || hasDesc) return "partial";
    return "missing";
  }

  function handleGenerate() {
    const fd = new FormData();
    fd.set("intent", "generate");
    fd.set("productsJson", JSON.stringify(products));
    selected.forEach((id) => fd.append("productId", id));
    setEdits({});
    fetcher.submit(fd, { method: "post" });
  }

  function handleApply() {
    const fd = new FormData();
    fd.set("intent", "apply");
    fd.set("itemsJson", JSON.stringify(displayItems));
    fetcher.submit(fd, { method: "post" });
  }

  const STATUS_STYLE = {
    complete: { bg: "#d4edda", color: "#155724", label: "Complete" },
    partial: { bg: "#fff3cd", color: "#856404", label: "Partial" },
    missing: { bg: "#f8d7da", color: "#721c24", label: "Missing" },
  } as const;

  return (
    <s-page heading="Meta Generator">

      {/* ── Apply result banner ── */}
      {applyResult && (
        <s-section>
          <div
            style={{
              padding: "12px 16px",
              borderRadius: 8,
              marginBottom: 8,
              background: applyResult.errors.length === 0 ? "#d4edda" : "#fff3cd",
              color: applyResult.errors.length === 0 ? "#155724" : "#856404",
            }}
          >
            {applyResult.errors.length === 0 ? (
              <>
                ✓ Applied meta tags to {applyResult.applied} product
                {applyResult.applied !== 1 ? "s" : ""} successfully.
              </>
            ) : (
              <>
                ⚠ Applied {applyResult.applied} products.{" "}
                {applyResult.errors.length} failed:{" "}
                {applyResult.errors.map((e) => `${e.title} (${e.message})`).join("; ")}
              </>
            )}
          </div>
        </s-section>
      )}

      {/* ── Preview & edit panel ── */}
      {displayItems.length > 0 && (
        <s-section heading="Preview &amp; Edit Generated Meta Tags">
          <s-stack direction="block" gap="base">
            {displayItems.map((item) => {
              const titleLen = item.metaTitle.length;
              const descLen = item.metaDescription.length;
              return (
                <div key={item.productId} style={CARD_STYLE}>
                  <s-stack direction="block" gap="base">
                    <strong style={{ fontSize: 14 }}>{item.title}</strong>

                    <div>
                      <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>
                        Meta Title
                      </div>
                      <input
                        type="text"
                        value={item.metaTitle}
                        onChange={(e) =>
                          setEdits((prev) => ({
                            ...prev,
                            [item.productId]: {
                              ...prev[item.productId],
                              metaTitle: e.target.value,
                            },
                          }))
                        }
                        style={{
                          display: "block",
                          width: "100%",
                          padding: "6px 8px",
                          border: "1px solid #c9cccf",
                          borderRadius: 4,
                          fontSize: 14,
                          boxSizing: "border-box",
                        }}
                      />
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: titleLen <= 60 ? "#008060" : "#d82c0d",
                        }}
                      >
                        {titleLen}/60 chars{titleLen > 60 ? " — too long" : " — ✓"}
                      </span>
                    </div>

                    <div>
                      <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>
                        Meta Description
                      </div>
                      <textarea
                        value={item.metaDescription}
                        onChange={(e) =>
                          setEdits((prev) => ({
                            ...prev,
                            [item.productId]: {
                              ...prev[item.productId],
                              metaDescription: e.target.value,
                            },
                          }))
                        }
                        rows={3}
                        style={{
                          display: "block",
                          width: "100%",
                          padding: "6px 8px",
                          border: "1px solid #c9cccf",
                          borderRadius: 4,
                          fontSize: 14,
                          resize: "vertical",
                          boxSizing: "border-box",
                        }}
                      />
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: descLen <= 155 ? "#008060" : "#d82c0d",
                        }}
                      >
                        {descLen}/155 chars{descLen > 155 ? " — too long" : " — ✓"}
                      </span>
                    </div>
                  </s-stack>
                </div>
              );
            })}

            <div style={{ paddingTop: 4 }}>
              <s-button
                variant="primary"
                onClick={handleApply}
              >
                {isApplying
                  ? "Applying…"
                  : `Apply to Shopify (${displayItems.length} product${displayItems.length !== 1 ? "s" : ""})`}
              </s-button>
            </div>
          </s-stack>
        </s-section>
      )}

      {/* ── Product list ── */}
      <s-section heading={`Products (${products.length})`}>

        {/* Controls bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 16,
            flexWrap: "wrap",
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <IndeterminateCheckbox
              checked={allSelected}
              indeterminate={someSelected}
              onChange={toggleAll}
            />
            <span style={{ fontSize: 14 }}>Select All</span>
          </label>

          <span style={{ fontSize: 14, color: "#6d7175" }}>
            {selected.size} of {products.length} selected
          </span>

          <s-button
            variant="primary"
            onClick={handleGenerate}
          >
            {isGenerating ? "Generating…" : "Generate Meta Tags"}
          </s-button>
        </div>

        {/* Table */}
        <div style={{ border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden" }}>
          {/* Header row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "40px 56px 1fr 190px 220px 90px",
              gap: 12,
              padding: "10px 16px",
              background: "#f6f6f7",
              fontWeight: 600,
              fontSize: 13,
              color: "#3d4044",
              borderBottom: "1px solid #e1e3e5",
            }}
          >
            <span />
            <span>Image</span>
            <span>Product</span>
            <span>SEO Title</span>
            <span>SEO Description</span>
            <span>Status</span>
          </div>

          {/* Product rows */}
          {products.map((product, idx) => {
            const status = seoStatus(product);
            const ss = STATUS_STYLE[status];
            const isApplied = seoMap[product.id]?.applied ?? false;

            return (
              <div
                key={product.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "40px 56px 1fr 190px 220px 90px",
                  gap: 12,
                  padding: "10px 16px",
                  borderBottom: idx < products.length - 1 ? "1px solid #e1e3e5" : "none",
                  alignItems: "center",
                  background: selected.has(product.id) ? "#f0f7ff" : isApplied ? "#f0fff4" : "white",
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(product.id)}
                  onChange={() => toggleOne(product.id)}
                  style={{ cursor: "pointer", width: 16, height: 16 }}
                />

                {product.featuredImage ? (
                  <img
                    src={product.featuredImage.url}
                    alt={product.title}
                    style={{
                      width: 44,
                      height: 44,
                      objectFit: "cover",
                      borderRadius: 4,
                      border: "1px solid #e1e3e5",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      background: "#f1f1f1",
                      borderRadius: 4,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 9,
                      color: "#8c9196",
                      textAlign: "center",
                      border: "1px solid #e1e3e5",
                    }}
                  >
                    No img
                  </div>
                )}

                <span style={{ fontSize: 13, color: "#3d4044" }}>{product.title}</span>

                <span style={{ fontSize: 13, color: product.seo.title ? "#3d4044" : "#8c9196" }}>
                  {product.seo.title
                    ? product.seo.title.length > 38
                      ? product.seo.title.slice(0, 38) + "…"
                      : product.seo.title
                    : "Not set"}
                </span>

                <span
                  style={{ fontSize: 13, color: product.seo.description ? "#3d4044" : "#8c9196" }}
                >
                  {product.seo.description
                    ? product.seo.description.length > 58
                      ? product.seo.description.slice(0, 58) + "…"
                      : product.seo.description
                    : "Not set"}
                </span>

                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 8px",
                    borderRadius: 12,
                    background: ss.bg,
                    color: ss.color,
                    fontSize: 12,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {ss.label}
                </span>
              </div>
            );
          })}

          {products.length === 0 && (
            <div style={{ padding: "32px 16px", textAlign: "center", color: "#8c9196" }}>
              No products found in this store.
            </div>
          )}
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
