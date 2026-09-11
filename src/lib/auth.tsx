import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { captureAuthLinkError, takeAuthLinkError } from "@/lib/auth-link-error";
import { keepStorageOnDevice } from "@/lib/installed-app";
import { clearSignupIntent, readSignupIntent, saveSignupIntentError } from "@/lib/signup-intent";

export type AppRole = "super_admin" | "company_admin" | "employee";

export interface Profile {
  id: string;
  full_name: string;
  company_id: string | null;
  pending_company_id: string | null;
  position: string | null;
}

export interface CompanyLite {
  id: string;
  name: string;
  plan: string;
  status: string;
  join_code: string | null;
}

interface AuthCtx {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  company: CompanyLite | null;
  roles: AppRole[];
  /** Highest-priority role for routing/UX — super_admin > company_admin > employee. */
  primaryRole: AppRole | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

const ROLE_PRIORITY: AppRole[] = ["super_admin", "company_admin", "employee"];

/**
 * Supervisor was folded into company_admin — the two roles now do the same job.
 * The enum label still exists in the database, so any row that predates the
 * merge (or an environment where it hasn't run yet) reads as a company admin
 * instead of leaving that user with no role at all.
 */
function normalizeRole(role: string): AppRole | null {
  if (role === "supervisor") return "company_admin";
  return ROLE_PRIORITY.includes(role as AppRole) ? (role as AppRole) : null;
}

async function runSignupIntent(email: string | null | undefined): Promise<boolean> {
  const intent = readSignupIntent(email);
  if (!intent) return false;

  const { error } =
    intent.kind === "create"
      ? await supabase.rpc("bootstrap_company", { _name: intent.companyName })
      : await supabase.rpc("join_company_by_code", { _code: intent.code });

  if (!error) {
    clearSignupIntent();
    return true;
  }
  // A Postgres-level rejection ("invalid company code", "already a member") will
  // never succeed on a retry, so drop it and park the reason for the "no company"
  // gate to show. A transport failure has no `code`; keep it and retry next load.
  if (error.code) {
    saveSignupIntentError(error.message);
    clearSignupIntent();
  }
  return false;
}

let intentInFlight: Promise<boolean> | null = null;

/**
 * Replay the company setup a signup couldn't finish (see `@/lib/signup-intent`).
 * Returns true when the profile changed and is worth re-reading.
 *
 * The first authenticated load calls `loadContext` twice — once from
 * `onAuthStateChange`, once from `getSession` — and they overlap. Sharing one
 * in-flight promise keeps `bootstrap_company`, which happily creates a second
 * company if asked, from running twice.
 */
function applySignupIntent(email: string | null | undefined): Promise<boolean> {
  if (!intentInFlight) {
    intentInFlight = runSignupIntent(email).finally(() => {
      intentInFlight = null;
    });
  }
  return intentInFlight;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [company, setCompany] = useState<CompanyLite | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  // Pull profile, role memberships, and the company row that the user belongs to.
  // Keep this resilient — a brand-new signup may not have a company yet.
  const loadContext = useCallback(async (authUser: Pick<User, "id" | "email"> | null) => {
    const uid = authUser?.id ?? null;
    if (!uid) {
      setProfile(null);
      setCompany(null);
      setRoles([]);
      return;
    }
    let [{ data: prof }, { data: roleRows }] = await Promise.all([
      supabase.from("profiles").select("id, full_name, company_id, pending_company_id, position").eq("id", uid).maybeSingle(),
      supabase.from("user_roles").select("role").eq("user_id", uid),
    ]);

    // A signup that couldn't reach the company RPCs (email confirmation was on,
    // so there was no session yet) left its request behind. Replay it now, while
    // `loading` is still true, so the UI never flashes the "no company" gate for
    // someone whose company is about to appear.
    if (prof && !prof.company_id && !prof.pending_company_id) {
      const applied = await applySignupIntent(authUser?.email);
      if (applied) {
        [{ data: prof }, { data: roleRows }] = await Promise.all([
          supabase.from("profiles").select("id, full_name, company_id, pending_company_id, position").eq("id", uid).maybeSingle(),
          supabase.from("user_roles").select("role").eq("user_id", uid),
        ]);
      }
    }

    setProfile(prof ?? null);
    setRoles(
      ((roleRows ?? []) as { role: string }[])
        .map((r) => normalizeRole(r.role))
        .filter((r): r is AppRole => r !== null),
    );
    if (prof?.company_id) {
      const { data: co } = await supabase
        .from("companies")
        .select("id, name, plan, status, join_code")
        .eq("id", prof.company_id)
        .maybeSingle();
      setCompany(co ?? null);
    } else {
      setCompany(null);
    }
  }, []);

  useEffect(() => {
    // Take a failed email link's reason out of the URL first — the redirect to
    // /login that follows would drop the fragment it arrived in.
    const linkFailed = captureAuthLinkError();
    // On a phone's home screen, ask the browser to keep the stored session.
    keepStorageOnDevice();

    // CRITICAL: subscribe BEFORE getSession so we never miss the initial event.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
      // Defer DB calls so we don't deadlock the auth callback.
      setTimeout(() => {
        void loadContext(s?.user ?? null).finally(() => setLoading(false));
      }, 0);
    });

    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      void loadContext(data.session?.user ?? null).finally(() => setLoading(false));
      if (linkFailed) {
        // Already signed in (a confirmation link clicked twice, say): the stale
        // link is moot. Otherwise the sign-in form is where the reason is shown —
        // including when Auth fell back to the site root instead of /dashboard.
        if (data.session) takeAuthLinkError();
        else if (window.location.pathname !== "/login") void navigate({ to: "/login" });
      }
    });

    return () => subscription.unsubscribe();
  }, [loadContext, navigate]);

  // Live-update the gating state when a super admin suspends/reactivates the
  // current user's company. The UI re-renders instantly with the new status.
  useEffect(() => {
    const cid = profile?.company_id;
    if (!cid) return;
    const channel = supabase
      .channel(`company-status-${cid}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "companies", filter: `id=eq.${cid}` },
        (payload) => {
          const next = payload.new as CompanyLite;
          setCompany((prev) => (prev ? { ...prev, ...next } : next));
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [profile?.company_id]);

  const refresh = useCallback(() => loadContext(user ?? null), [loadContext, user]);

  const signOut = useCallback(async () => {
    // "local" ends only this device's session. The default, "global", revokes
    // every refresh token the user has, so signing out on a laptop also threw
    // them out of the app on their phone.
    await supabase.auth.signOut({ scope: "local" });
    setSession(null);
    setUser(null);
    setProfile(null);
    setCompany(null);
    setRoles([]);
  }, []);

  const primaryRole = ROLE_PRIORITY.find((r) => roles.includes(r)) ?? null;

  return (
    <Ctx.Provider value={{ session, user, profile, company, roles, primaryRole, loading, refresh, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/**
 * Label for a role value read straight from the database, where the retired
 * "supervisor" can still appear on rows written before the merge (invitations,
 * most of all). Indexing ROLE_LABEL directly with one of those renders nothing.
 */
export function roleLabel(role: string): string {
  const normalized = normalizeRole(role);
  return normalized ? ROLE_LABEL[normalized] : "Member";
}

export const ROLE_LABEL: Record<AppRole, string> = {
  super_admin: "Super Admin",
  company_admin: "Company Admin",
  employee: "Employee",
};
