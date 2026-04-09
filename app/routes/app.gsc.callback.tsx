import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { exchangeCodeForTokens, getExpiresAt } from "../utils/gsc.server";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return redirect(`/app/settings?gsc=error&message=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return redirect(`/app/settings?gsc=error&message=Missing%20code%20or%20state`);
  }

  const stateRecord = await prisma.gscOauthState.findUnique({ where: { state } });
  if (!stateRecord || stateRecord.usedAt) {
    return redirect(`/app/settings?gsc=error&message=Invalid%20or%20used%20state`);
  }

  if (stateRecord.shop !== session.shop) {
    return redirect(`/app/settings?gsc=error&message=Shop%20mismatch`);
  }

  const ageMs = Date.now() - stateRecord.createdAt.getTime();
  if (ageMs > STATE_TTL_MS) {
    return redirect(`/app/settings?gsc=error&message=State%20expired`);
  }

  try {
    const token = await exchangeCodeForTokens(code);
    const existing = await prisma.gscAccount.findUnique({ where: { shop: session.shop } });
    const refreshToken = token.refresh_token ?? existing?.refreshToken ?? null;

    await prisma.gscAccount.upsert({
      where: { shop: session.shop },
      create: {
        shop: session.shop,
        accessToken: token.access_token,
        refreshToken,
        scope: token.scope ?? null,
        tokenType: token.token_type ?? null,
        expiresAt: getExpiresAt(token.expires_in),
      },
      update: {
        accessToken: token.access_token,
        refreshToken,
        scope: token.scope ?? null,
        tokenType: token.token_type ?? null,
        expiresAt: getExpiresAt(token.expires_in),
      },
    });

    await prisma.gscOauthState.update({
      where: { state },
      data: { usedAt: new Date() },
    });

    return redirect(`/app/settings?gsc=connected`);
  } catch (e) {
    return redirect(`/app/settings?gsc=error&message=${encodeURIComponent(String(e))}`);
  }
};

export default function GscCallback() {
  return null;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
