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
import { useQueryClient } from "@tanstack/react-query";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { captureAuthLinkError, takeAuthLinkError } from "@/lib/auth-link-error";
import { keepStorageOnDevice } from "@/lib/installed-app";
import { releaseNativePush } from "@/lib/native/push";
import { translate } from "@/lib/i18n";
import { clearSignupIntent, readSignupIntent, saveSignupIntentError } from "@/lib/signup-intent";
import { readRememberedCompany, rememberCompany, setActiveCompanyId } from "@/lib/active-company";
import { endGhostPerson, isGhostingPerson } from "@/lib/ghost-person";

export type AppRole = "super_admin" | "company_admin" | "supervisor" | "employee";

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

/** One of the companies this account belongs to (see my_companies()). */
export interface Membership {
  companyId: string;
  name: string;
  /** The company's own status: active, pending, suspended… */
  companyStatus: string;
  /** This person's membership there. */
  status: "active" | "suspended";
  /** Raw role values in that company, as stored. */
  roles: string[];
  /** Unread notifications from that company. */
  unread: number;
}

interface MyCompanyRow {
  company_id: string;
  name: string;
  company_status: string;
  membership_status: string;
  roles: string[] | null;
  unread: number | null;
}

function toMembership(row: MyCompanyRow): Membership {
  return {
    companyId: row.company_id,
    name: row.name,
    companyStatus: row.company_status,
    status: row.membership_status === "suspended" ? "suspended" : "active",
    roles: row.roles ?? [],
    unread: row.unread ?? 0,
  };
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
  /** Every company this account belongs to, the selected one included. */
  memberships: Membership[];
  /**
   * Work in another of this person's companies. Clears every cached query, so
   * nothing read for one company is ever shown in another.
   */
  switchCompany: (companyId: string) => Promise<void>;
  /** Roles in the selected company (plus super admin, which is platform-wide). */
  roles: AppRole[];
  /** Highest-priority role for routing/UX — super_admin > company_admin > supervisor > employee. */
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

const ROLE_PRIORITY: AppRole[] = ["super_admin", "company_admin", "supervisor", "employee"];

/**
 * A role value read from the database. A supervisor manages only the
 * departments an admin assigns them (20261121120000_supervisor_departments.sql);
 * anything this build does not know reads as no role.
 */
function normalizeRole(role: string): AppRole | null {
  return ROLE_PRIORITY.includes(role as AppRole) ? (role as AppRole) : null;
}

/** Runs some part of the company: an admin everywhere, a supervisor for their people. */
export function isManagerRole(role: AppRole | null | undefined): boolean {
  return role === "company_admin" || role === "super_admin" || role === "supervisor";
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
  memberships: Membership[];
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
  const readAccount = async () => {
    const [p, r, m] = await Promise.all([
      supabase.from("profiles").select(PROFILE_COLS).eq("id", uid).maybeSingle(),
      supabase.from("user_roles").select("role, company_id").eq("user_id", uid),
      supabase.rpc("my_companies"),
    ]);
    if (p.error) throw p.error;
    if (r.error) throw r.error;
    const prof = p.data as Profile | null;
    const roleRows = (r.data ?? []) as { role: string; company_id: string | null }[];
    let memberships: Membership[];
    if (m.error) {
      // A database without the memberships migration yet: the profile's company
      // is the only one, exactly as before.
      if (m.error.code !== "PGRST202" && m.error.code !== "42883") throw m.error;
      memberships = prof?.company_id
        ? [
            {
              companyId: prof.company_id,
              name: "",
              companyStatus: "active",
              status: "active",
              roles: roleRows.filter((x) => x.company_id === prof.company_id).map((x) => x.role),
              unread: 0,
            },
          ]
        : [];
    } else {
      memberships = ((m.data ?? []) as MyCompanyRow[]).map(toMembership);
    }
    return { prof, roleRows, memberships };
  };

  let { prof, roleRows, memberships } = await readAccount();

  // A signup that couldn't reach the company RPCs (email confirmation was on,
  // so there was no session yet) left its request behind. Replay it now, while
  // `loading` is still true, so the UI never flashes the "no company" gate for
  // someone whose company is about to appear.
  if (prof && memberships.length === 0 && !prof.pending_company_id) {
    const applied = await applySignupIntent(email);
    if (applied) ({ prof, roleRows, memberships } = await readAccount());
  }

  const isSuperAdmin = roleRows.some((r) => r.role === "super_admin");

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
      setActiveCompanyId(g.company_id);
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
          memberships,
          roles: ["company_admin"],
          ghost: { companyId: co.id, companyName: co.name, startedAt: g.started_at },
          isSuperAdmin,
        };
      }
    }
  }

  // The selected company: this device's last pick, else the account's, else
  // the first one — but only ever a company this person is active in.
  const active = memberships.filter((m) => m.status === "active");
  const remembered = readRememberedCompany(uid);
  const selected =
    active.find((m) => m.companyId === remembered) ??
    active.find((m) => m.companyId === prof?.company_id) ??
    active[0] ??
    null;
  setActiveCompanyId(selected?.companyId ?? null);
  if (selected && selected.companyId !== prof?.company_id) {
    // Keep the account's default in step, for realtime and new devices.
    void supabase.rpc("switch_company", { _company: selected.companyId });
  }

  let company: CompanyLite | null = null;
  if (selected) {
    const { data: co, error } = await supabase
      .from("companies")
      .select(COMPANY_COLS)
      .eq("id", selected.companyId)
      .maybeSingle();
    if (error) throw error;
    company = co ?? null;
  }

  const roles = roleRows
    .filter((r) => r.role === "super_admin" || (selected && r.company_id === selected.companyId))
    .map((r) => normalizeRole(r.role))
    .filter((r): r is AppRole => r !== null);

  return {
    profile: prof ? { ...prof, company_id: company?.id ?? null } : null,
    company,
    memberships,
    roles: [...new Set(roles)],
    ghost: null,
    isSuperAdmin,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [company, setCompany] = useState<CompanyLite | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
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
  const queryClient = useQueryClient();

  // Pull profile, role memberships, and the company row that the user belongs to.
  // Keep this resilient — a brand-new signup may not have a company yet.
  /**
   * Only the newest load may write to state. Sign-in starts two at once (one
   * from onAuthStateChange, one from getSession), and an older one finishing
   * last used to overwrite the right answer with a stale one.
   */
  const loadSeq = useRef(0);

  const loadContext = useCallback(async (authUser: Pick<User, "id" | "email"> | null): Promise<boolean> => {
    const seq = ++loadSeq.current;
    const uid = authUser?.id ?? null;
    if (!uid) {
      setActiveCompanyId(null);
      setProfile(null);
      setCompany(null);
      setMemberships([]);
      setRoles([]);
      setGhost(null);
      setIsSuperAdmin(false);
      setLoadError(false);
      contextFor.current = null;
      return true;
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
        if (seq !== loadSeq.current) return false;
        if (attempt >= RETRY_DELAYS_MS.length) {
          console.warn("[auth] could not load account", e);
          setLoadError(true);
          contextFor.current = null;
          return true;
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        if (seq !== loadSeq.current) return false;
      }
    }
    if (seq !== loadSeq.current) return false;

    setLoadError(false);
    setIsSuperAdmin(ctx.isSuperAdmin);
    setGhost(ctx.ghost);
    setProfile(ctx.profile);
    setRoles(ctx.roles);
    setCompany(ctx.company);
    setMemberships(ctx.memberships);
    contextFor.current = uid;
    return true;
  }, []);

  /**
   * End the loading screen, but only for the load whose answer is now in
   * state. Sign-in and a fresh page start two loads at once; the older one
   * used to clear `loading` on its way out while the newer was still reading,
   * so for a moment a signed-in person with no company in state was shown the
   * "Add your company" screen.
   */
  const endLoading = useCallback((landed: boolean) => {
    if (landed) setLoading(false);
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
        void loadContext(s?.user ?? null).then(endLoading, () => setLoading(false));
      }, 0);
    });

    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      void loadContext(data.session?.user ?? null).then(endLoading, () => setLoading(false));
      if (linkFailed) {
        // Already signed in (a confirmation link clicked twice, say): the stale
        // link is moot. Otherwise the sign-in form is where the reason is shown —
        // including when Auth fell back to the site root instead of /dashboard.
        if (data.session) takeAuthLinkError();
        else if (window.location.pathname !== "/login") void navigate({ to: "/login" });
      }
    });

    return () => subscription.unsubscribe();
  }, [loadContext, endLoading, navigate]);

  // Live-update the gating state when a super admin suspends/reactivates the
  // current user's company. The UI re-renders instantly with the new status.
  useEffect(() => {
    const cid = company?.id;
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
  }, [company?.id]);

  // A refresh that overtakes a sign-in load is now the newest one, so it is
  // the one that ends the loading screen.
  const refresh = useCallback(async () => {
    endLoading(await loadContext(user ?? null));
  }, [loadContext, endLoading, user]);

  /**
   * Everything cached belongs to the company it was read for. Stop what is in
   * flight and drop it all, so the next screen can only show the new company.
   */
  const dropCompanyCache = useCallback(async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
  }, [queryClient]);

  const switchCompany = useCallback(
    async (companyId: string) => {
      const uid = user?.id;
      if (!uid || companyId === company?.id) return;
      const { error } = await supabase.rpc("switch_company", { _company: companyId });
      if (error) throw error;
      rememberCompany(uid, companyId);
      // From here on every request is for the new company.
      setActiveCompanyId(companyId);
      await dropCompanyCache();
      await loadContext(user ?? null);
      void navigate({ to: "/dashboard" });
    },
    [user, company?.id, dropCompanyCache, loadContext, navigate],
  );

  // A membership can be suspended or removed from somewhere else. The database
  // already refuses everything the moment that happens; this brings the screen
  // into line — on returning to the app, and once a minute while it is open.
  useEffect(() => {
    const cid = company?.id;
    if (!user || !cid || ghost) return;
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const { data, error } = await supabase.rpc("my_companies");
        if (error) return;
        const rows = (data ?? []) as MyCompanyRow[];
        if (!rows.some((m) => m.company_id === cid && m.membership_status === "active")) {
          await dropCompanyCache();
          await loadContext(user);
          void navigate({ to: "/dashboard" });
        } else {
          setMemberships(rows.map(toMembership));
        }
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => void check(), 60_000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [user, company?.id, ghost, dropCompanyCache, loadContext, navigate]);

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
    // Ghosting someone: "sign out" means leave their account, back to your own.
    if (isGhostingPerson()) {
      await endGhostPerson();
      return;
    }
    // "local" ends only this device's session. The default, "global", revokes
    // every refresh token the user has, so signing out on a laptop also threw
    // them out of the app on their phone.
    // This phone stops receiving the account's notifications. First, while the
    // session still exists: row-level security needs it to delete the row.
    await releaseNativePush();
    await supabase.auth.signOut({ scope: "local" });
    // A load still in flight for the account just signed out of must not land.
    loadSeq.current++;
    setActiveCompanyId(null);
    queryClient.clear();
    setSession(null);
    setUser(null);
    setProfile(null);
    setCompany(null);
    setMemberships([]);
    setRoles([]);
    setGhost(null);
    setIsSuperAdmin(false);
    setLoadError(false);
    // Nobody's context is loaded now, so signing back in — even as the same
    // person — waits for a fresh read instead of rendering against these nulls.
    contextFor.current = null;
  }, [queryClient]);

  const primaryRole = ROLE_PRIORITY.find((r) => roles.includes(r)) ?? null;

  return (
    <Ctx.Provider
      value={{
        session,
        user,
        profile,
        company,
        memberships,
        switchCompany,
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
 * Label for a role value read straight from the database. Indexing ROLE_LABEL
 * directly with a value this build does not know renders nothing.
 */
export function roleLabel(role: string): string {
  const normalized = normalizeRole(role);
  return translate(normalized ? ROLE_LABEL[normalized] : "Member");
}

export const ROLE_LABEL: Record<AppRole, string> = {
  super_admin: "Super Admin",
  company_admin: "Company Admin",
  supervisor: "Supervisor",
  employee: "Employee",
};
