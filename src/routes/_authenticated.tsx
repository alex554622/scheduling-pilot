import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Calendar,
  LayoutDashboard,
  Users,
  RefreshCw,
  CalendarOff,
  Building2,
  Settings,
  LogOut,
  Menu,
  BarChart3,
  PanelLeftClose,
  PanelLeftOpen,
  Clock,
  FileClock,
  UserCheck,
  ShieldCheck,
  SlidersHorizontal,
  Network,
  CalendarCheck,
  ScrollText,
  CreditCard,
  Gauge,
  Lock,
  Gift,
  Tablet,
  ClipboardList,
} from "lucide-react";
import { useAuth, ROLE_LABEL, type AppRole } from "@/lib/auth";
import { useAppRules } from "@/lib/app-rules";
import { useCapabilities, CAPABILITY_LABELS, type CapabilityKey } from "@/lib/capabilities";
import { useTrialStatus, trialCountdown } from "@/lib/trial";
import { NotificationsBell } from "@/components/notifications-bell";
import { BrandLogo, BrandMark } from "@/components/brand";
import { JoinCompanyGate } from "@/components/join-company-gate";
import { noindexSeo } from "@/lib/seo";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  // The signed-in application must never appear in search results. This is a
  // crawler directive only — access is still enforced by auth and RLS.
  head: () => noindexSeo("Scheduling Pilot"),
  component: AuthLayout,
});

/** `needs` is the plan capability that unlocks the item; omitted means always. */
type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  roles: AppRole[];
  needs?: CapabilityKey;
};

const NAV: NavItem[] = [
  {
    to: "/dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    roles: ["super_admin", "company_admin", "employee"],
  },
  { to: "/platform", label: "Platform", icon: Gauge, roles: ["super_admin"] },
  { to: "/companies", label: "Companies", icon: Building2, roles: ["super_admin"] },
  {
    to: "/schedule",
    label: "Schedule",
    icon: Calendar,
    roles: ["company_admin", "employee"],
    needs: "schedule_design",
  },
  {
    to: "/schedule-sheet",
    label: "Schedule sheet",
    icon: ClipboardList,
    roles: ["company_admin"],
    needs: "schedule_design",
  },
  { to: "/employees", label: "Employees", icon: Users, roles: ["company_admin"] },
  {
    to: "/organization",
    label: "Organization",
    icon: Network,
    roles: ["company_admin"],
    needs: "org_structure",
  },
  {
    to: "/availability",
    label: "Availability",
    icon: CalendarCheck,
    roles: ["company_admin", "employee"],
    needs: "availability",
  },
  {
    to: "/timeclock",
    label: "Time clock",
    icon: Clock,
    roles: ["company_admin", "employee"],
    needs: "time_clock",
  },
  {
    to: "/timecards",
    label: "Timecards",
    icon: FileClock,
    roles: ["company_admin", "employee"],
    needs: "timecards",
  },
  {
    to: "/whos-in",
    label: "Who's in",
    icon: UserCheck,
    roles: ["company_admin", "super_admin"],
    needs: "time_clock",
  },
  {
    to: "/shared-clock-in",
    label: "Shared clock-in",
    icon: Tablet,
    roles: ["company_admin"],
    needs: "time_clock",
  },
  {
    to: "/punch-corrections",
    label: "Punch corrections",
    icon: ShieldCheck,
    roles: ["company_admin", "super_admin"],
    needs: "time_clock",
  },
  {
    to: "/trades",
    label: "Shift trades",
    icon: RefreshCw,
    roles: ["company_admin", "employee"],
    needs: "shift_trades",
  },
  {
    to: "/time-off",
    label: "Time off",
    icon: CalendarOff,
    roles: ["company_admin", "employee"],
    needs: "time_off",
  },
  {
    to: "/reports",
    label: "Reports",
    icon: BarChart3,
    roles: ["company_admin", "super_admin"],
    needs: "reports",
  },
  {
    to: "/audit-log",
    label: "Audit log",
    icon: ScrollText,
    roles: ["super_admin", "company_admin"],
    needs: "audit_log",
  },
  { to: "/billing", label: "Billing", icon: CreditCard, roles: ["super_admin", "company_admin"] },
  {
    to: "/app-rules",
    label: "App rules",
    icon: SlidersHorizontal,
    roles: ["super_admin", "company_admin"],
  },
  {
    to: "/settings",
    label: "Settings",
    icon: Settings,
    roles: ["super_admin", "company_admin", "employee"],
  },
];

const COLLAPSE_KEY = "ps-sidebar-collapsed";

/** Shown in place of a page the company's plan doesn't include. */
function PlanLocked({ capability, isAdmin }: { capability: CapabilityKey; isAdmin: boolean }) {
  const label = CAPABILITY_LABELS.find((c) => c.key === capability)?.label ?? "This feature";
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-border bg-card p-8 text-center shadow-[var(--shadow-card)]">
      <Lock className="mx-auto h-9 w-9 text-muted-foreground" />
      <h2 className="mt-4 text-xl font-semibold text-foreground">{label} isn't in your plan</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {isAdmin
          ? "Upgrade your subscription to switch it on for your company."
          : "Ask a company admin to upgrade your subscription."}
      </p>
      {isAdmin && (
        <Link
          to="/billing"
          className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          See plans
        </Link>
      )}
    </div>
  );
}

function AuthLayout() {
  const { user, loading, primaryRole, profile, company, signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false); // mobile drawer
  const [collapsed, setCollapsed] = useState(false); // desktop rail
  const path = useRouterState({ select: (s) => s.location.pathname });
  // Must run before any of the early returns below. Called after them, the hook
  // count changes between renders and React throws "Rendered more hooks than
  // during the previous render", taking down the whole authenticated area.
  const rules = useAppRules();
  const { capabilities } = useCapabilities();
  const { trial } = useTrialStatus();

  // Restore collapsed preference once on mount.
  useEffect(() => {
    try {
      const v = localStorage.getItem(COLLAPSE_KEY);
      if (v === "1") setCollapsed(true);
    } catch {
      /* ignore */
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // Wait for the AuthProvider to finish hydrating before redirecting; otherwise
  // a quick flash sends authenticated users to /login on every reload.
  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [loading, user, navigate]);

  if (loading || !user) {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  // Block company members when their company isn't active. Super admins bypass this gate
  // so they can still reach /companies and approve / unsuspend accounts.
  if (primaryRole && primaryRole !== "super_admin" && company && company.status !== "active") {
    const isPending = company.status === "pending";
    return (
      <div className="grid min-h-screen place-items-center bg-secondary/30 px-4">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-[var(--shadow-card)]">
          <h2 className="text-xl font-semibold text-foreground">
            {isPending ? "Awaiting approval" : `Account ${company.status.replace("_", " ")}`}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {isPending
              ? `${company.name} is pending review by a platform administrator. You'll get access as soon as it's approved.`
              : `${company.name} is currently ${company.status.replace("_", " ")}. Please contact support to restore access.`}
          </p>
          <button
            onClick={async () => {
              await signOut();
              navigate({ to: "/login" });
            }}
            className="mt-6 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  // User has asked to join a company but a company admin hasn't approved yet.
  if (!company && profile?.pending_company_id) {
    return (
      <div className="grid min-h-screen place-items-center bg-secondary/30 px-4">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-[var(--shadow-card)]">
          <h2 className="text-xl font-semibold text-foreground">Awaiting admin approval</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your request to join the company has been sent. A company admin needs to approve you
            before you can access the workspace.
          </p>
          <button
            onClick={async () => {
              await signOut();
              navigate({ to: "/login" });
            }}
            className="mt-6 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  // No company and nothing pending — an "employee only" signup, a signup whose
  // join code was rejected, or an account whose profile row was never created.
  // Every nav item needs a company, so offer the join code instead of an empty
  // shell. `profile` is optional on purpose: requiring it hid this screen from
  // exactly the accounts stuck without one.
  if (!profile?.company_id && !profile?.pending_company_id && primaryRole !== "super_admin") {
    return (
      <JoinCompanyGate
        onSignOut={async () => {
          await signOut();
          navigate({ to: "/login" });
        }}
      />
    );
  }

  const items = primaryRole
    ? NAV.filter((n) => n.roles.includes(primaryRole))
        // The plan decides whether the company has the feature at all…
        .filter((n) => !n.needs || capabilities[n.needs])
        // …and the company's own rules decide whether staff may use it.
        .filter((n) => {
          if (n.to === "/trades" && !rules.allow_shift_trades && primaryRole === "employee")
            return false;
          if (n.to === "/time-off" && !rules.allow_time_off_requests && primaryRole === "employee")
            return false;
          // One schedule screen in the menu, not two: an admin picks the
          // builder or the monthly sheet in App rules. Employees are not part
          // of that choice — they keep the schedule they can actually read.
          if (primaryRole !== "employee") {
            if (n.to === "/schedule" && rules.schedule_menu === "sheet") return false;
            if (n.to === "/schedule-sheet" && rules.schedule_menu !== "sheet") return false;
          }
          return true;
        })
    : [];
  // Hiding the nav item isn't enough — someone can still type the URL, or hold a
  // bookmark from before the plan changed. Resolve the current route against the
  // same table and lock the page itself.
  const currentNav = NAV.find((n) => path === n.to || path.startsWith(`${n.to}/`));
  const lockedCapability =
    currentNav?.needs && !capabilities[currentNav.needs] ? currentNav.needs : null;

  const displayName = profile?.full_name || user.email || "Account";
  const initials = displayName
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const sideWidth = collapsed ? "lg:w-16" : "lg:w-64";

  return (
    <div data-print-root className="flex min-h-screen bg-secondary/30">
      {/* A column, not a box with something pinned to the bottom of it: the nav
          scrolls on its own and the account card sits below it, so a long menu
          can never end up underneath Sign out. Held to the viewport's height on
          desktop so the card stays in sight however long the page is. */}
      <aside
        data-print-hide
        className={`fixed bottom-0 left-0 top-0 z-30 flex w-64 shrink-0 transform flex-col border-r border-border bg-[var(--sidebar-bg)] transition-[width,transform] duration-200 lg:sticky lg:bottom-auto lg:top-0 lg:h-screen lg:translate-x-0 ${sideWidth} ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div
          className={`flex h-16 shrink-0 items-center border-b border-border ${collapsed ? "justify-center px-2" : "px-5"}`}
        >
          {collapsed ? <BrandMark size={40} /> : <BrandLogo className="h-12" />}
        </div>
        <nav className={`min-h-0 flex-1 overflow-y-auto ${collapsed ? "px-2 py-4" : "px-3 py-4"}`}>
          {items.map((n, i) => {
            const active = path === n.to;
            return (
              <Link
                key={`${n.label}-${i}`}
                to={n.to}
                onClick={() => setOpen(false)}
                title={collapsed ? n.label : undefined}
                className={`mb-1 flex items-center gap-3 rounded-lg text-sm font-medium transition-colors ${collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2.5"} ${active ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
              >
                <n.icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="truncate">{n.label}</span>}
              </Link>
            );
          })}
        </nav>
        <div
          className={`shrink-0 ${collapsed ? "mx-2 mb-3" : "mx-3 mb-3"} rounded-xl border border-border bg-card p-3`}
        >
          {collapsed ? (
            <div className="flex flex-col items-center gap-2">
              <div
                className="grid h-9 w-9 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary"
                title={displayName}
              >
                {initials || "?"}
              </div>
              <button
                onClick={async () => {
                  await signOut();
                  navigate({ to: "/login" });
                }}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary">
                {initials || "?"}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {primaryRole ? ROLE_LABEL[primaryRole] : "No role yet"}
                </p>
              </div>
              <button
                onClick={async () => {
                  await signOut();
                  navigate({ to: "/login" });
                }}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Sign out"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {open && (
        <div
          data-print-hide
          className="fixed inset-0 z-20 bg-foreground/30 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-print-hide
          className="sticky top-0 z-10 flex h-16 items-center justify-between gap-3 border-b border-border bg-card/80 px-4 backdrop-blur md:px-8"
        >
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() => setOpen(true)}
              className="grid h-11 w-11 place-items-center rounded-md text-muted-foreground hover:bg-accent lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            <button
              onClick={toggleCollapsed}
              className="hidden h-11 w-11 place-items-center rounded-md text-muted-foreground hover:bg-accent lg:grid"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? (
                <PanelLeftOpen className="h-5 w-5" />
              ) : (
                <PanelLeftClose className="h-5 w-5" />
              )}
            </button>
            <div className="min-w-0">
              <p className="truncate text-xs text-muted-foreground">
                {company?.name ?? "Platform"}
              </p>
              <h1 className="truncate text-base font-semibold text-foreground">
                {primaryRole ? `${ROLE_LABEL[primaryRole]} workspace` : "Workspace"}
              </h1>
            </div>
          </div>
          <NotificationsBell />
        </header>
        {(trial.trialing || trial.expired) && (
          <div
            data-print-hide
            className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5 text-sm md:px-8 ${
              trial.expired
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-primary/25 bg-primary-soft text-primary"
            }`}
          >
            <span className="flex items-center gap-2">
              <Gift className="h-4 w-4 shrink-0" />
              {trial.expired ? (
                <>
                  Your {trial.plan ?? "free"} trial has ended — features are locked until you pick a
                  plan.
                </>
              ) : (
                <>
                  <span className="font-medium">{trial.plan ?? "Free"} trial</span> ·{" "}
                  {trialCountdown(trial.days_left)}
                  {trial.ends_at && <> · ends {new Date(trial.ends_at).toLocaleDateString()}</>}
                </>
              )}
            </span>
            {primaryRole === "company_admin" && (
              <Link to="/billing" className="shrink-0 font-medium underline underline-offset-2">
                See plans
              </Link>
            )}
          </div>
        )}
        <main data-print-root className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
          {lockedCapability ? (
            <PlanLocked capability={lockedCapability} isAdmin={primaryRole === "company_admin"} />
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}
