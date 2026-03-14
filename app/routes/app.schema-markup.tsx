import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function SchemaMarkup() {
  return (
    <s-page heading="Schema Markup">
      <s-section heading="JSON-LD Structured Data">
        <s-paragraph>
          Coming soon — generate and apply JSON-LD structured data (schema
          markup) to your products for enhanced search engine visibility.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
