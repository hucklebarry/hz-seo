import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { decrypt } from "../utils/encryption.server";
import { generateBlogContent } from "../utils/ai-content.server";
import type { ProductForContent } from "../utils/ai-content.server";
import { useState, useEffect } from "react";

// ---------------------------------------------------------------------------
// Markdown → HTML (used server-side for publish, client-side for preview)
// ---------------------------------------------------------------------------

function fmt(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

export function markdownToHtml(md: string): string {
  const lines = md.trim().split("\n");
  const out: string[] = [];
  let paraLines: string[] = [];
  let inList = false;

  function flushPara() {
    if (paraLines.length) {
      out.push(`<p>${paraLines.join(" ")}</p>`);
      paraLines = [];
    }
  }
  function closeList() {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  }

  for (const line of lines) {
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    const h3 = line.match(/^### (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h1 = line.match(/^# (.+)/);
    const li = line.match(/^[-*] (.+)/);

    if (h3) {
      flushPara();
      closeList();
      out.push(`<h3>${fmt(h3[1])}</h3>`);
    } else if (h2) {
      flushPara();
      closeList();
      out.push(`<h2>${fmt(h2[1])}</h2>`);
    } else if (h1) {
      flushPara();
      closeList();
      out.push(`<h1>${fmt(h1[1])}</h1>`);
    } else if (li) {
      flushPara();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${fmt(li[1])}</li>`);
    } else {
      closeList();
      paraLines.push(fmt(line));
    }
  }

  flushPara();
  closeList();
  return out.join("");
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Fetch products
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
            featuredImage { url }
            variants(first: 1) {
              edges {
                node {
                  price
                  sku
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
  const products: ProductForContent[] = json.data?.products?.edges?.map((e: any) => e.node) ?? [];

  // Check if API key is configured
  const settings = await prisma.appSettings.findUnique({ where: { shop: session.shop } });
  const hasApiKey = !!(settings?.aiApiKey);

  // Load recent generated content
  const recentContent = await prisma.generatedContent.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, title: true, contentType: true, published: true, createdAt: true, articleId: true },
  });

  return { products, hasApiKey, recentContent, shop: session.shop };
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
    // Load and decrypt API key
    const settings = await prisma.appSettings.findUnique({ where: { shop: session.shop } });
    if (!settings?.aiApiKey) {
      return {
        intent: "generate",
        error: "No API key found. Please configure your Anthropic API key in Settings first.",
      };
    }

    let apiKey: string;
    try {
      apiKey = decrypt(settings.aiApiKey);
    } catch (e) {
      return { intent: "generate", error: `Failed to decrypt API key: ${String(e)}` };
    }

    const selectedIds = formData.getAll("productId") as string[];
    const productsJson = formData.get("productsJson") as string;
    const allProducts: ProductForContent[] = JSON.parse(productsJson);
    const products = allProducts.filter((p) => selectedIds.includes(p.id));

    if (products.length === 0) {
      return { intent: "generate", error: "Please select at least one product." };
    }

    const contentType = formData.get("contentType") as string;
    const tone = formData.get("tone") as string;
    const wordCount = formData.get("wordCount") as string;
    const targetKeyword = (formData.get("targetKeyword") as string) ?? "";

    try {
      const result = await generateBlogContent({
        contentType,
        tone,
        wordCount,
        targetKeyword,
        products,
        apiKey,
        aiModel: settings.aiModel,
      });

      return {
        intent: "generate",
        title: result.title,
        metaDesc: result.metaDesc,
        body: result.body,
        contentType,
        productIds: JSON.stringify(selectedIds),
      };
    } catch (e) {
      return { intent: "generate", error: `Generation failed: ${String(e)}` };
    }
  }

  // ── Publish ──
  if (intent === "publish") {
    const title = formData.get("title") as string;
    const metaDesc = formData.get("metaDesc") as string;
    const bodyMarkdown = formData.get("body") as string;
    const contentType = formData.get("contentType") as string;
    const productIds = formData.get("productIds") as string;

    // Convert markdown to HTML
    const bodyHtml = markdownToHtml(bodyMarkdown);

    // Get first blog
    const blogsResp = await admin.graphql(`#graphql
      {
        blogs(first: 1) {
          edges {
            node {
              id
              title
            }
          }
        }
      }
    `);
    const blogsJson = await blogsResp.json();
    const blog = blogsJson.data?.blogs?.edges?.[0]?.node;

    if (!blog) {
      return {
        intent: "publish",
        error:
          "No blog found in your store. Create one in Shopify Admin → Online Store → Blog Posts first.",
      };
    }

    // Create article
    const articleResp = await admin.graphql(
      `#graphql
      mutation articleCreate($article: ArticleCreateInput!) {
        articleCreate(article: $article) {
          article {
            id
            title
            handle
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          article: {
            blogId: blog.id,
            title,
            body: bodyHtml,
            author: { name: "MetaForge SEO" },
            isPublished: false,
            metafields: [
              {
                namespace: "global",
                key: "description_tag",
                value: metaDesc,
                type: "single_line_text_field",
              },
              {
                namespace: "global",
                key: "title_tag",
                value: title,
                type: "single_line_text_field",
              },
            ],
          },
        },
      },
    );

    const articleJson = await articleResp.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userErrors: any[] = articleJson.data?.articleCreate?.userErrors ?? [];

    if (userErrors.length > 0) {
      return {
        intent: "publish",
        error: userErrors.map((e) => e.message).join(", "),
      };
    }

    const article = articleJson.data?.articleCreate?.article;

    // Save to DB
    await prisma.generatedContent.create({
      data: {
        shop: session.shop,
        contentType,
        title,
        metaDesc,
        body: bodyMarkdown,
        productIds,
        published: true,
        articleId: article?.id ?? null,
      },
    });

    // Extract numeric ID from GID for admin URL
    const numericId = article?.id?.split("/").pop();

    return {
      intent: "publish",
      articleId: article?.id,
      handle: article?.handle,
      blogTitle: blog.title,
      numericId,
    };
  }

  return { error: "Unknown intent" };
};

// ---------------------------------------------------------------------------
// Shared styles
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

const CONTENT_TYPES = [
  {
    value: "buying_guide",
    label: "Buying Guide",
    desc: "Help readers choose the right product — great for comparison-heavy categories.",
  },
  {
    value: "product_spotlight",
    label: "Product Spotlight",
    desc: "Deep-dive on a single product. Best with 1 product selected.",
  },
  {
    value: "comparison",
    label: "Comparison Post",
    desc: "Side-by-side comparison of 2+ products. Best with 2–5 products.",
  },
];

const TONES = ["Professional", "Casual", "Technical"];
const WORD_COUNTS = ["500", "800", "1200", "1500"];

function formatContentType(ct: string): string {
  return CONTENT_TYPES.find((c) => c.value === ct)?.label ?? ct;
}

export default function BlogGenerator() {
  const { products, hasApiKey, recentContent, shop } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [contentType, setContentType] = useState("buying_guide");
  const [tone, setTone] = useState("Professional");
  const [wordCount, setWordCount] = useState("800");
  const [targetKeyword, setTargetKeyword] = useState("");
  const [isEditMode, setIsEditMode] = useState(false);
  const [editBody, setEditBody] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editMetaDesc, setEditMetaDesc] = useState("");

  const isGenerating =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "generate";
  const isPublishing =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "publish";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = fetcher.data as any;
  const genResult = data?.intent === "generate" && !data.error ? data : null;
  const genError = data?.intent === "generate" && data.error ? data.error : null;
  const pubResult = data?.intent === "publish" && !data.error ? data : null;
  const pubError = data?.intent === "publish" && data.error ? data.error : null;

  // Populate edit fields when generation completes
  useEffect(() => {
    if (genResult) {
      setEditTitle(genResult.title);
      setEditMetaDesc(genResult.metaDesc);
      setEditBody(genResult.body);
      setIsEditMode(false);
    }
  }, [genResult?.title, genResult?.body]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredProducts = filter
    ? products.filter(
        (p) =>
          p.title.toLowerCase().includes(filter.toLowerCase()) ||
          p.vendor?.toLowerCase().includes(filter.toLowerCase()),
      )
    : products;

  function toggleProduct(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 5) {
        next.add(id);
      }
      return next;
    });
  }

  function handleGenerate() {
    if (selected.size === 0) return;
    const fd = new FormData();
    fd.set("intent", "generate");
    fd.set("productsJson", JSON.stringify(products));
    fd.set("contentType", contentType);
    fd.set("tone", tone);
    fd.set("wordCount", wordCount);
    fd.set("targetKeyword", targetKeyword);
    selected.forEach((id) => fd.append("productId", id));
    fetcher.submit(fd, { method: "post" });
  }

  function handlePublish() {
    const fd = new FormData();
    fd.set("intent", "publish");
    fd.set("title", editTitle);
    fd.set("metaDesc", editMetaDesc);
    fd.set("body", editBody);
    fd.set("contentType", genResult?.contentType ?? contentType);
    fd.set("productIds", genResult?.productIds ?? JSON.stringify([...selected]));
    fetcher.submit(fd, { method: "post" });
  }

  const previewHtml = editBody ? markdownToHtml(editBody) : "";

  return (
    <s-page heading="Blog Generator">

      {/* ── No API key warning ── */}
      {!hasApiKey && (
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
            ⚠ No Anthropic API key configured.{" "}
            <a href="/app/settings" style={{ color: "#856404", fontWeight: 600 }}>
              Go to Settings
            </a>{" "}
            to add your key before generating content.
          </div>
        </s-section>
      )}

      {/* ── Publish success ── */}
      {pubResult && (
        <s-section>
          <div
            style={{
              padding: "14px 16px",
              background: "#d4edda",
              color: "#155724",
              borderRadius: 8,
              fontSize: 14,
            }}
          >
            ✓ Draft article published to your "{pubResult.blogTitle}" blog!{" "}
            <a
              href={`https://${shop}/admin/articles/${pubResult.numericId}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: "#155724", fontWeight: 600 }}
            >
              View in Shopify Admin →
            </a>
          </div>
        </s-section>
      )}

      {/* ── Generation / publish errors ── */}
      {(genError || pubError) && (
        <s-section>
          <div
            style={{
              padding: "12px 16px",
              background: "#f8d7da",
              color: "#721c24",
              borderRadius: 8,
              fontSize: 14,
            }}
          >
            ✗ {genError ?? pubError}
          </div>
        </s-section>
      )}

      {/* ── Generated preview / edit / publish ── */}
      {genResult && (
        <s-section heading="Generated Content">
          <s-stack direction="block" gap="base">

            {/* Title & meta edit */}
            <div style={CARD_STYLE}>
              <s-stack direction="block" gap="base">

                <div>
                  <label
                    style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}
                  >
                    Post Title (H1)
                  </label>
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "8px 10px",
                      border: "1px solid #c9cccf",
                      borderRadius: 4,
                      fontSize: 14,
                      boxSizing: "border-box",
                    }}
                  />
                </div>

                <div>
                  <label
                    style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}
                  >
                    Meta Description
                  </label>
                  <textarea
                    value={editMetaDesc}
                    onChange={(e) => setEditMetaDesc(e.target.value)}
                    rows={2}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "8px 10px",
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
                      color: editMetaDesc.length <= 155 ? "#008060" : "#d82c0d",
                    }}
                  >
                    {editMetaDesc.length}/155 chars
                    {editMetaDesc.length > 155 ? " — too long" : " — ✓"}
                  </span>
                </div>

              </s-stack>
            </div>

            {/* Body preview / edit toggle */}
            <div style={CARD_STYLE}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 12,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600 }}>Blog Content</span>
                <button
                  onClick={() => setIsEditMode((v) => !v)}
                  style={{
                    padding: "4px 12px",
                    background: isEditMode ? "#008060" : "#f6f6f7",
                    color: isEditMode ? "white" : "#3d4044",
                    border: "1px solid #c9cccf",
                    borderRadius: 4,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  {isEditMode ? "Preview" : "Edit"}
                </button>
              </div>

              {isEditMode ? (
                <textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={30}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "10px 12px",
                    border: "1px solid #c9cccf",
                    borderRadius: 4,
                    fontSize: 13,
                    fontFamily: "monospace",
                    resize: "vertical",
                    boxSizing: "border-box",
                    lineHeight: 1.6,
                  }}
                />
              ) : (
                <div
                  style={{
                    padding: "12px 16px",
                    background: "#fafafa",
                    borderRadius: 6,
                    border: "1px solid #e1e3e5",
                    lineHeight: 1.7,
                    fontSize: 14,
                    color: "#3d4044",
                    maxHeight: 600,
                    overflowY: "auto",
                  }}
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              )}

              <p style={{ fontSize: 12, color: "#6d7175", marginTop: 8, marginBottom: 0 }}>
                {editBody.split(/\s+/).filter(Boolean).length} words ·{" "}
                {editBody.length} characters
              </p>
            </div>

            {/* Publish button */}
            <div style={{ paddingTop: 4 }}>
              <s-button
                variant="primary"
                onClick={handlePublish}
              >
                {isPublishing ? "Publishing…" : "Publish as Draft to Shopify Blog"}
              </s-button>
              <p style={{ fontSize: 12, color: "#6d7175", marginTop: 8 }}>
                Saves as a draft — review and publish from Shopify Admin → Online Store → Blog Posts.
              </p>
            </div>

          </s-stack>
        </s-section>
      )}

      {/* ── Generator form ── */}
      <s-section heading="1. Select Products (up to 5)">
        <s-stack direction="block" gap="base">

          {selected.size >= 5 && (
            <div
              style={{
                padding: "8px 12px",
                background: "#fff3cd",
                color: "#856404",
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              Maximum 5 products selected.
            </div>
          )}

          <input
            type="text"
            placeholder="Filter products by name or vendor..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              border: "1px solid #c9cccf",
              borderRadius: 4,
              fontSize: 14,
              boxSizing: "border-box",
            }}
          />

          <div
            style={{
              border: "1px solid #e1e3e5",
              borderRadius: 8,
              maxHeight: 320,
              overflowY: "auto",
            }}
          >
            {filteredProducts.length === 0 && (
              <div
                style={{ padding: "24px 16px", textAlign: "center", color: "#8c9196", fontSize: 14 }}
              >
                No products match your filter.
              </div>
            )}
            {filteredProducts.map((product, idx) => {
              const isSelected = selected.has(product.id);
              const price = product.variants.edges[0]?.node.price;
              const disabled = !isSelected && selected.size >= 5;

              return (
                <label
                  key={product.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 16px",
                    borderBottom:
                      idx < filteredProducts.length - 1 ? "1px solid #e1e3e5" : "none",
                    background: isSelected ? "#f0f7ff" : "white",
                    cursor: disabled ? "not-allowed" : "pointer",
                    opacity: disabled ? 0.5 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleProduct(product.id)}
                    disabled={disabled}
                    style={{ width: 16, height: 16, cursor: disabled ? "not-allowed" : "pointer" }}
                  />
                  <span style={{ flex: 1, fontSize: 14, color: "#3d4044" }}>{product.title}</span>
                  {product.vendor && (
                    <span style={{ fontSize: 12, color: "#6d7175" }}>{product.vendor}</span>
                  )}
                  {price && (
                    <span style={{ fontSize: 13, color: "#3d4044", fontWeight: 500 }}>
                      ${price}
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          <p style={{ fontSize: 13, color: "#6d7175", margin: 0 }}>
            {selected.size} of 5 products selected
          </p>

        </s-stack>
      </s-section>

      <s-section heading="2. Content Type">
        <s-stack direction="block" gap="base">
          {CONTENT_TYPES.map((ct) => (
            <label
              key={ct.value}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                cursor: "pointer",
                padding: "10px 14px",
                border: `1px solid ${contentType === ct.value ? "#005bd3" : "#e1e3e5"}`,
                borderRadius: 8,
                background: contentType === ct.value ? "#f0f7ff" : "white",
              }}
            >
              <input
                type="radio"
                name="contentType"
                value={ct.value}
                checked={contentType === ct.value}
                onChange={() => setContentType(ct.value)}
                style={{ marginTop: 2, cursor: "pointer" }}
              />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#3d4044" }}>{ct.label}</div>
                <div style={{ fontSize: 13, color: "#6d7175", marginTop: 2 }}>{ct.desc}</div>
              </div>
            </label>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="3. Options (optional)">
        <div style={CARD_STYLE}>
          <s-stack direction="block" gap="base">

            <div>
              <label
                style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}
              >
                Target Keyword
              </label>
              <input
                type="text"
                value={targetKeyword}
                onChange={(e) => setTargetKeyword(e.target.value)}
                placeholder="e.g. commercial stainless steel work table"
                style={{
                  display: "block",
                  width: "100%",
                  padding: "8px 10px",
                  border: "1px solid #c9cccf",
                  borderRadius: 4,
                  fontSize: 14,
                  boxSizing: "border-box",
                }}
              />
              <p style={{ fontSize: 12, color: "#6d7175", marginTop: 4, marginBottom: 0 }}>
                Claude will naturally incorporate this keyword throughout the post.
              </p>
            </div>

            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div>
                <label
                  style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}
                >
                  Tone
                </label>
                <select
                  value={tone}
                  onChange={(e) => setTone(e.target.value)}
                  style={{
                    padding: "8px 10px",
                    border: "1px solid #c9cccf",
                    borderRadius: 4,
                    fontSize: 14,
                    background: "white",
                    minWidth: 160,
                  }}
                >
                  {TONES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}
                >
                  Target Word Count
                </label>
                <select
                  value={wordCount}
                  onChange={(e) => setWordCount(e.target.value)}
                  style={{
                    padding: "8px 10px",
                    border: "1px solid #c9cccf",
                    borderRadius: 4,
                    fontSize: 14,
                    background: "white",
                    minWidth: 120,
                  }}
                >
                  {WORD_COUNTS.map((w) => (
                    <option key={w} value={w}>
                      {w} words
                    </option>
                  ))}
                </select>
              </div>
            </div>

          </s-stack>
        </div>
      </s-section>

      {/* ── Generate button ── */}
      <s-section>
        <s-stack direction="inline" gap="base">
          <s-button
            variant="primary"
            onClick={handleGenerate}
          >
            {isGenerating
              ? "Generating with Claude AI…"
              : `Generate ${formatContentType(contentType)}`}
          </s-button>
          {selected.size === 0 && (
            <span style={{ fontSize: 13, color: "#6d7175", lineHeight: "32px" }}>
              Select at least 1 product above to generate
            </span>
          )}
        </s-stack>
        {isGenerating && (
          <p style={{ fontSize: 13, color: "#6d7175", marginTop: 8 }}>
            Generating content with Claude AI — this may take 15–30 seconds…
          </p>
        )}
      </s-section>

      {/* ── Recent generations ── */}
      {recentContent.length > 0 && (
        <s-section heading="Recent Generations">
          <div style={{ border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden" }}>
            {recentContent.map((item, idx) => (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 16px",
                  borderBottom: idx < recentContent.length - 1 ? "1px solid #e1e3e5" : "none",
                  background: "white",
                }}
              >
                <span
                  style={{
                    padding: "2px 8px",
                    background: "#f6f6f7",
                    borderRadius: 12,
                    fontSize: 11,
                    color: "#6d7175",
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatContentType(item.contentType)}
                </span>
                <span style={{ flex: 1, fontSize: 14, color: "#3d4044" }}>{item.title}</span>
                <span
                  style={{
                    padding: "2px 8px",
                    background: item.published ? "#d4edda" : "#f6f6f7",
                    color: item.published ? "#155724" : "#6d7175",
                    borderRadius: 12,
                    fontSize: 11,
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.published ? "Published" : "Draft"}
                </span>
                <span style={{ fontSize: 12, color: "#8c9196", whiteSpace: "nowrap" }}>
                  {new Date(item.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        </s-section>
      )}

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
