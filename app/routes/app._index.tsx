import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(`#graphql
    query {
      productsCount {
        count
      }
    }
  `);

  const data = await response.json();
  const productCount = data.data?.productsCount?.count ?? 0;

  return { productCount };
};

export default function Index() {
  const { productCount } = useLoaderData<typeof loader>();

  return (
    <s-page heading="MetaForge SEO">
      <s-section heading="Welcome to MetaForge SEO">
        <s-paragraph>
          AI-powered SEO automation for your Shopify store. Auto-generate
          optimized meta titles, descriptions, JSON-LD structured data, and blog
          content directly from your product data.
        </s-paragraph>
      </s-section>

      <s-section heading="Store Overview">
        <s-card>
          <s-stack direction="block" gap="base">
            <s-text variant="headingMd">Products</s-text>
            <s-text variant="heading2xl">{productCount}</s-text>
            <s-text tone="subdued">
              Total products in your store ready for SEO optimization
            </s-text>
          </s-stack>
        </s-card>
      </s-section>

      <s-section slot="aside" heading="Quick Actions">
        <s-stack direction="block" gap="base">
          <s-button href="/app/meta-generator" variant="primary">
            Generate Meta Tags
          </s-button>
          <s-button href="/app/schema-markup" variant="secondary">
            Add Schema Markup
          </s-button>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="About MetaForge SEO">
        <s-unordered-list>
          <s-list-item>AI-generated meta titles &amp; descriptions</s-list-item>
          <s-list-item>JSON-LD structured data / schema markup</s-list-item>
          <s-list-item>Bulk processing for large catalogs</s-list-item>
          <s-list-item>Optimized for B2B &amp; commercial stores</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
