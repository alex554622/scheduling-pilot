import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { captureAuthLinkError, takeAuthLinkError } from "@/lib/auth-link-error";
import { keepStorageOnDevice } from "@/lib/installed-app";
import { releaseNativePush } from "@/lib/native/push";
import { translate } from "@/lib/i18n";
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

/**
 * A super admin standing in as a company's admin (see the ghost mode
 * migration). While set, `profile.company_id`, `company` and `roles` all
 * describe that company and the company_admin role, so every page behaves
 * exactly as it would for that company's own admin.
 */
export interface GhostSession {
  companyId: string;
  companyName: string;
  startedAt: string;
}

interface AuthCtx {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  company: CompanyLite | null;
  roles: AppRole[];
  /** Highest-priority role for routing/UX — super_admin > company_admin > employee. */
  primaryRole: AppRole | null;
  /** The company a super admin is ghosting, or null. */
  ghost: GhostSession | null;
  /** The account really is a super admin, ghosting or not. */
  isSuperAdmin: boolean;
  /**
   * Signed in, but the server didn't answer when asked who this is. Profile,
   * company and roles are unknown — not empty — so no gate should act on them.
   */
  loadError: boolean;
  startGhost: (companyId: string) => Promise<void>;
  endGhost: () => Promise<void>;
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

/** Waits between attempts to read the account before giving up. */
const RETRY_DELAYS_MS = [500, 1500, 3000];

interface LoadedContext {
  profile: Profile | null;
  company: CompanyLite | null;
  roles: AppRole[];
  ghost: GhostSession | null;
  isSuperAdmin: boolean;
}

const PROFILE_COLS = "id, full_name, company_id, pending_company_id, position";
const COMPANY_COLS = "id, name, plan, status, join_code";

/**
 * Read who the signed-in person is. Throws when the server didn't answer, so
 * the caller can tell "no company" apart from "couldn't ask".
 */
async function fetchContext(uid: string, email: string | null | undefined): Promise<LoadedContext> {
  const readProfileAndRoles = async () => {
    const [p, r] = await Promise.all([
      supabase.from("profiles").select(PROFILE_COLS).eq("id", uid).maybeSingle(),
      supabase.from("user_roles").select("role").eq("user_id", uid),
    ]);
    if (p.error) throw p.error;
    if (r.error) throw r.error;
    return { prof: p.data as Profile | null, roleRows: (r.data ?? []) as { role: string }[] };
  };

  let { prof, roleRows } = await readProfileAndRoles();

  // A signup that couldn't reach the company RPCs (email confirmation was on,
  // so there was no session yet) left its request behind. Replay it now, while
  // `loading` is still true, so the UI never flashes the "no company" gate for
  // someone whose company is about to appear.
  if (prof && !prof.company_id && !prof.pending_company_id) {
    const applied = await applySignupIntent(email);
    if (applied) ({ prof, roleRows } = await readProfileAndRoles());
  }

  const roles = roleRows
    .map((r) => normalizeRole(r.role))
    .filter((r): r is AppRole => r !== null);
  const isSuperAdmin = roles.includes("super_admin");

  // Ghost mode: present the super admin as that company's admin. The database
  // grants the same thing on its side (current_company_id / has_role), so the
  // two always agree about what this person may see and change. An error here
  // just means no ghost session (or a database without the table yet).
  if (isSuperAdmin) {
    const { data: g } = await supabase
      .from("ghost_sessions")
      .select("company_id, started_at")
      .eq("super_admin_id", uid)
      .is("ended_at", null)
      .maybeSingle();
    if (g) {
      const { data: co, error } = await supabase
        .from("companies")
        .select(COMPANY_COLS)
        .eq("id", g.company_id)
        .maybeSingle();
      if (error) throw error;
      if (co) {
        return {
          profile: prof ? { ...prof, company_id: co.id, pending_company_id: null } : null,
          company: co,
          roles: ["company_admin"],
          ghost: { companyId: co.id, companyName: co.name, startedAt: g.started_at },
          isSuperAdmin,
        };
      }
    }
  }

  let company: CompanyLite | null = null;
  if (prof?.company_id) {
    const { data: co, error } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .eq("id", prof.company_id)
      .maybeSingle();
    if (error) throw error;
    company = co ?? null;
  }
  return { profile: prof, company, roles, ghost: null, isSuperAdmin };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [company, setCompany] = useState<CompanyLite | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [ghost, setGhost] = useState<GhostSession | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  /**
   * Whose profile, roles and company are the ones currently in state.
   *
   * `loading` has to mean "the context matches the signed-in user", not merely
   * "the first load finished". A sign-in arrives on a page that already
   * finished loading as an anonymous visitor, so without this the layout
   * rendered against a null profile and flashed the "add your company" gate at
   * someone who has one.
   */
  const contextFor = useRef<string | null>(null);
  const navigate = useNavigate();

  // Pull profile, role memberships, and the company row that the user belongs to.
  // Keep this resilient — a brand-new signup may not have a company yet.
  /**
   * Only the newest load may write to state. Sign-in starts two at once (one
   * from onAuthStateChange, one from getSession), and an older one finishing
   * last used to overwrite the right answer with a stale one.
   */
  const loadSeq = useRef(0);

  const loadContext = useCallback(async (authUser: Pick<User, "id" | "email"> | null) => {
    const seq = ++loadSeq.current;
    const uid = authUser?.id ?? null;
    if (!uid) {
      setProfile(null);
      setCompany(null);
      setRoles([]);
      setGhost(null);
      setIsSuperAdmin(false);
      setLoadError(false);
      contextFor.current = null;
      return;
    }

    // A server that is down or still starting must never read as "this person
    // has no company": that put people on the join-code screen until they
    // refreshed. Retry a few times, then say the server can't be reached.
    let ctx: LoadedContext | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        ctx = await fetchContext(uid, authUser?.email);
        break;
      } catch (e) {
        if (seq !== loadSeq.current) return;
        if (attempt >= RETRY_DELAYS_MS.length) {
          console.warn("[auth] could not load account", e);
          setLoadError(true);
          contextFor.current = null;
          return;
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        if (seq !== loadSeq.current) return;
      }
    }
    if (seq !== loadSeq.current) return;

    setLoadError(false);
    setIsSuperAdmin(ctx.isSuperAdmin);
    setGhost(ctx.ghost);
    setProfile(ctx.profile);
    setRoles(ctx.roles);
    setCompany(ctx.company);
    contextFor.current = uid;
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
      // Someone new is signing in (or out): hold the app on its loading screen
      // until their context arrives, rather than letting the layout decide what
      // to show from the previous user's — or nobody's — profile. A token
      // refresh for the same person changes nothing here, so the page they are
      // reading doesn't blank out every hour.
      if ((s?.user?.id ?? null) !== contextFor.current) setLoading(true);
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

  const startGhost = useCallback(
    async (companyId: string) => {
      const { error } = await supabase.rpc("start_ghost_session", { _company: companyId });
      if (error) throw error;
      await loadContext(user ?? null);
    },
    [loadContext, user],
  );

  const endGhost = useCallback(async () => {
    const { error } = await supabase.rpc("end_ghost_session");
    if (error) throw error;
    await loadContext(user ?? null);
  }, [loadContext, user]);

  const signOut = useCallback(async () => {
    // "local" ends only this device's session. The default, "global", revokes
    // every refresh token the user has, so signing out on a laptop also threw
    // them out of the app on their phone.
    // This phone stops receiving the account's notifications. First, while the
    // session still exists: row-level security needs it to delete the row.
    await releaseNativePush();
    await supabase.auth.signOut({ scope: "local" });
    // A load still in flight for the account just signed out of must not land.
    loadSeq.current++;
    setSession(null);
    setUser(null);
    setProfile(null);
    setCompany(null);
    setRoles([]);
    setGhost(null);
    setIsSuperAdmin(false);
    setLoadError(false);
    // Nobody's context is loaded now, so signing back in — even as the same
    // person — waits for a fresh read instead of rendering against these nulls.
    contextFor.current = null;
  }, []);

  const primaryRole = ROLE_PRIORITY.find((r) => roles.includes(r)) ?? null;

  return (
    <Ctx.Provider
      value={{
        session,
        user,
        profile,
        company,
        roles,
        primaryRole,
        ghost,
        isSuperAdmin,
        loadError,
        startGhost,
        endGhost,
        loading,
        refresh,
        signOut,
      }}
    >
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
  return translate(normalized ? ROLE_LABEL[normalized] : "Member");
}

export const ROLE_LABEL: Record<AppRole, string> = {
  super_admin: "Super Admin",
  company_admin: "Company Admin",
  employee: "Employee",
};
