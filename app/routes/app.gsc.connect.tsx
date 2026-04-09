import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { buildGoogleOAuthUrl, generateOauthState } from "../utils/gsc.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const state = generateOauthState();
    const authUrl = buildGoogleOAuthUrl(state);
    await prisma.gscOauthState.create({
      data: { shop: session.shop, state },
    });
    return redirect(authUrl);
  } catch (e) {
    const msg = encodeURIComponent(String(e));
    return redirect(`/app/settings?gsc=error&message=${msg}`);
  }
};

export default function GscConnect() {
  return null;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
