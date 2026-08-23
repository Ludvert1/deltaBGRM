import { NextRequest } from "next/server";

/**
 * Cron and ingest endpoints are protected by a shared secret.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when the
 * env var is set. If CRON_SECRET is unset the routes stay open — convenient for
 * a first deploy, but set it before the URL is public.
 */
export function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  if (req.nextUrl.searchParams.get("secret") === secret) return true;

  // Vercel marks its own cron invocations; trust them when the secret is set
  // but the platform did not attach it (older projects).
  return req.headers.get("x-vercel-cron") === "1";
}

export function cronSecretConfigured(): boolean {
  return Boolean(process.env.CRON_SECRET);
}
