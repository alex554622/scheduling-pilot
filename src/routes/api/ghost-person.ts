import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Ghost as one person: a platform admin opens the app signed in as a specific
 * account, to see exactly what that person sees and fix things for them.
 *
 * Company ghost mode (start_ghost_session) makes the admin an admin of a
 * company; it can't show one employee's own time clock, because "own" is
 * auth.uid() throughout the database. This mints a real session for the target
 * instead: generateLink makes a one-time magic-link token without sending any
 * email, and verifying it on the server hands back that person's tokens.
 *
 *   POST { action: "start", userId }            → { access_token, refresh_token }
 *   POST { action: "end", targetAccessToken }   → { ok: true }
 *
 * Both need the platform admin's own access token as the bearer. "end" revokes
 * only the ghost session (scope "local"), so the person's own phone stays
 * signed in. Both ends go to the person's company audit log, with the admin as
 * the actor. Platform admins can't be ghosted.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function requirePlatformAdmin(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  if (!(await isPlatformAdmin(data.user.id))) return null;
  return data.user;
}

async function isPlatformAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "super_admin")
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function audit(actorId: string, targetId: string, action: string) {
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("company_id")
    .eq("id", targetId)
    .maybeSingle();
  const { error } = await supabaseAdmin.from("audit_logs").insert({
    company_id: profile?.company_id ?? null,
    actor_id: actorId,
    action,
    entity_type: "user",
    entity_id: targetId,
  });
  if (error) console.error(`[ghost] audit ${action} failed:`, error.message);
}

export const Route = createFileRoute("/api/ghost-person")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          return await handle(request);
        } catch (e) {
          console.error("[ghost] request failed:", e);
          return json({ error: "Ghost mode is not available on this server right now." }, 500);
        }
      },
    },
  },
});

async function handle(request: Request): Promise<Response> {
  const admin = await requirePlatformAdmin(request);
  if (!admin) return json({ error: "Only a platform admin can do this." }, 403);

  let body: { action?: string; userId?: string; targetAccessToken?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request." }, 400);
  }

  if (body.action === "start") {
    const userId = body.userId ?? "";
    if (!userId || userId === admin.id) return json({ error: "Pick another account." }, 400);
    if (await isPlatformAdmin(userId)) {
      return json({ error: "Platform admins can't be ghosted." }, 400);
    }
    const { data: target, error: getErr } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (getErr || !target.user) return json({ error: "Account not found." }, 404);
    if (!target.user.email)
      return json({ error: "This account has no email to sign in with." }, 400);

    const { data: link, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: target.user.email,
    });
    if (linkErr || !link.properties?.hashed_token) {
      console.error("[ghost] generateLink failed:", linkErr?.message);
      return json({ error: "Couldn't open a session for this account." }, 500);
    }

    // A throwaway client: verifyOtp signs *it* in, and the shared admin
    // client must never hold a user session.
    const verifier = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
      },
    );
    const { data: verified, error: verifyErr } = await verifier.auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: "magiclink",
    });
    if (verifyErr || !verified.session) {
      console.error("[ghost] verifyOtp failed:", verifyErr?.message);
      return json({ error: "Couldn't open a session for this account." }, 500);
    }

    await audit(admin.id, userId, "ghost.person_started");
    return json({
      access_token: verified.session.access_token,
      refresh_token: verified.session.refresh_token,
    });
  }

  if (body.action === "end") {
    const token = body.targetAccessToken ?? "";
    if (token) {
      const { data: who } = await supabaseAdmin.auth.getUser(token);
      const { error } = await supabaseAdmin.auth.admin.signOut(token, "local");
      if (error) console.error("[ghost] ending ghost session failed:", error.message);
      if (who?.user) await audit(admin.id, who.user.id, "ghost.person_ended");
    }
    return json({ ok: true });
  }

  return json({ error: "Bad request." }, 400);
}
