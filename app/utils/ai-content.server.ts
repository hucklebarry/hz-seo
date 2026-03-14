import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProductForContent {
  id: string;
  title: string;
  description: string;
  productType: string;
  vendor: string;
  tags: string[];
  variants: { edges: { node: { price: string; sku?: string | null } }[] };
}

export interface GeneratedContent {
  title: string;
  metaDesc: string;
  body: string; // Markdown
}

export interface GenerateOptions {
  contentType: string;
  tone: string;
  wordCount: string;
  targetKeyword: string;
  products: ProductForContent[];
  apiKey: string;
  aiModel: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function formatProduct(p: ProductForContent): string {
  const price = p.variants.edges[0]?.node.price
    ? `$${p.variants.edges[0].node.price}`
    : "price not listed";
  const sku = p.variants.edges[0]?.node.sku;
  const desc = stripHtml(p.description).slice(0, 400);

  const parts = [
    `Product: ${p.title}`,
    p.vendor ? `Brand/Vendor: ${p.vendor}` : null,
    p.productType ? `Category: ${p.productType}` : null,
    `Starting Price: ${price}`,
    sku ? `SKU: ${sku}` : null,
    p.tags.length ? `Tags: ${p.tags.slice(0, 10).join(", ")}` : null,
    desc ? `Description: ${desc}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return parts;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildSystemPrompt(tone: string, wordCount: string): string {
  return `You are an expert ecommerce SEO content writer. You write blog posts for online stores that are:
- Optimized for search engines with natural keyword usage
- Genuinely helpful and informative for the target audience
- Written in a ${tone} tone
- Structured with H2 and H3 headings for scannability
- Approximately ${wordCount} words in length

Output the blog post in Markdown format. Include:
1. An SEO-optimized title as an H1 heading (first line)
2. A meta description (max 155 characters) on the very next line, prefixed exactly with "META:" (no blank line between title and META)
3. The full blog post body with proper H2 and H3 heading hierarchy
4. A conclusion section with a clear call-to-action

Do NOT use generic filler. Every paragraph must contain specific, useful information drawn from the product data provided. Reference actual product names, specs, and prices.`;
}

export function buildUserPrompt(
  contentType: string,
  products: ProductForContent[],
  targetKeyword: string,
): string {
  const productData = products.map(formatProduct).join("\n\n---\n\n");
  const keywordNote = targetKeyword
    ? `\n\nTarget keyword to naturally incorporate: "${targetKeyword}"`
    : "";

  if (contentType === "buying_guide") {
    return `Write a comprehensive buying guide blog post to help readers choose the right product from these options:

${productData}${keywordNote}

The guide should cover: what to look for when buying, how to compare the options, specific use cases for each product, practical advice based on the reader's needs, and a recommendation section. Reference specific product names, features, and prices throughout.`;
  }

  if (contentType === "product_spotlight") {
    const product = products[0];
    return `Write an in-depth product spotlight blog post about the following product:

${formatProduct(product)}${keywordNote}

Cover: what makes this product stand out, its key features and specifications, ideal use cases and who it's for, tips for getting the most out of it, and why customers should consider it. Be specific — reference the actual product name, features, and price.`;
  }

  if (contentType === "comparison") {
    return `Write a detailed comparison blog post contrasting the following products to help readers decide which is right for them:

${productData}${keywordNote}

Structure the comparison around: key differences in specs/features/price, best use cases for each, pros and cons, and a clear recommendation for different buyer types. Be fair and specific — reference actual product names, specs, and prices.`;
  }

  return `Write an SEO-optimized blog post about the following products:\n\n${productData}${keywordNote}`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

export function parseGeneratedContent(raw: string): GeneratedContent {
  const lines = raw.trim().split("\n");
  let title = "";
  let metaDesc = "";
  const bodyLines: string[] = [];

  for (const line of lines) {
    if (!title && line.startsWith("# ")) {
      title = line.slice(2).trim();
      bodyLines.push(line); // keep H1 in body for preview
    } else if (line.startsWith("META:")) {
      metaDesc = line.slice(5).trim().slice(0, 155);
      // intentionally not added to body
    } else {
      bodyLines.push(line);
    }
  }

  return {
    title: title || "Generated Blog Post",
    metaDesc,
    body: bodyLines.join("\n").trim(),
  };
}

// ---------------------------------------------------------------------------
// Main generation function
// ---------------------------------------------------------------------------

export async function generateBlogContent(options: GenerateOptions): Promise<GeneratedContent> {
  const { contentType, tone, wordCount, targetKeyword, products, apiKey, aiModel } = options;

  const client = new Anthropic({ apiKey });
  const systemPrompt = buildSystemPrompt(tone, wordCount);
  const userPrompt = buildUserPrompt(contentType, products, targetKeyword);

  const message = await client.messages.create({
    model: aiModel,
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const firstBlock = message.content[0];
  if (firstBlock.type !== "text") {
    throw new Error("Unexpected response type from Claude API.");
  }

  return parseGeneratedContent(firstBlock.text);
}
