import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Loader2,
  Search,
  ShieldCheck,
  Trash2,
  UserCheck,
  Users,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, ROLE_LABEL, type AppRole } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Every account on the platform, whether or not it ever got anywhere.
 *
 * The Companies page can only show people who belong to a company, because
 * that is what `profiles` records. An account that signed up and never
 * confirmed its email, or one created while the profile trigger was missing,
 * existed only in `auth.users` and appeared on no screen at all. This page
 * reads `admin_accounts()`, which starts from `auth.users` and joins the rest
 * on — so the accounts that went nowhere are the ones it shows first.
 */
export const Route = createFileRoute("/_authenticated/accounts")({
  component: AccountsPage,
});

interface AccountRow {
  user_id: string;
  email: string | null;
  email_confirmed: boolean;
  created_at: string;
  last_sign_in_at: string | null;
  full_name: string;
  company_id: string | null;
  company_name: string | null;
  pending_company_id: string | null;
  pending_company_name: string | null;
  is_active: boolean;
  has_profile: boolean;
  roles: string[];
}

type CompanyLite = { id: string; name: string; status: string };

/** The roles a platform admin can hand out, and what each one means here. */
const ASSIGNABLE: { value: AppRole | ""; label: string }[] = [
  { value: "", label: "No role" },
  { value: "employee", label: "Employee" },
  { value: "company_admin", label: "Company Admin" },
  { value: "super_admin", label: "Platform Admin" },
];

function fmtDate(s: string | null): string {
  return s ? new Date(s).toLocaleDateString([], { dateStyle: "medium" }) : "never";
}

function AccountsPage() {
  const { primaryRole, loading, user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "stranded" | "pending" | "unconfirmed">("all");
  const [err, setErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AccountRow | null>(null);
  const [approving, setApproving] = useState<AccountRow | null>(null);

  useEffect(() => {
    if (!loading && primaryRole && primaryRole !== "super_admin") navigate({ to: "/dashboard" });
  }, [loading, primaryRole, navigate]);

  const isSuper = primaryRole === "super_admin";

  const accountsQ = useQuery({
    queryKey: ["admin-accounts"],
    enabled: isSuper,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("admin_accounts");
      if (error) throw error;
      return (data ?? []) as AccountRow[];
    },
  });

  const companiesQ = useQuery({
    queryKey: ["admin-accounts-companies"],
    enabled: isSuper,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("id, name, status")
        .order("name");
      if (error) throw error;
      return (data ?? []) as CompanyLite[];
    },
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin-accounts"] });
    // The companies screens count members, so they are stale the moment one of
    // these lands.
    void qc.invalidateQueries({ queryKey: ["companies-people"] });
    void qc.invalidateQueries({ queryKey: ["companies-roles"] });
    void qc.invalidateQueries({ queryKey: ["companies-admin"] });
  };

  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : String(e));

  const setCompany = useMutation({
    mutationFn: async (v: { userId: string; companyId: string | null }) => {
      const { error } = await supabase.rpc("admin_set_user_company", {
        _user: v.userId,
        _company: v.companyId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setErr(null);
      refresh();
    },
    onError: fail,
  });

  const setRole = useMutation({
    mutationFn: async (v: { userId: string; companyId: string | null; role: AppRole | null }) => {
      const { error } = await supabase.rpc("admin_set_user_role", {
        _user: v.userId,
        // Platform admin belongs to no company; every other role is granted
        // inside one.
        _company: v.role === "super_admin" ? null : v.companyId,
        _role: v.role,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setErr(null);
      refresh();
    },
    onError: fail,
  });

  const approve = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("approve_membership", { _user: userId });
      if (error) throw error;
    },
    onSuccess: () => {
      setErr(null);
      refresh();
    },
    onError: fail,
  });

  /**
   * Approving an account that belongs nowhere: the company and the role in one
   * action, because they are one decision. Leaving a platform admin to set two
   * dropdowns in the right order and hope is not an approval, it is a chore
   * with a wrong answer available at every step.
   */
  const approveInto = useMutation({
    mutationFn: async (v: { userId: string; companyId: string; role: AppRole | null }) => {
      const { error: cErr } = await supabase.rpc("admin_set_user_company", {
        _user: v.userId,
        _company: v.companyId,
      });
      if (cErr) throw cErr;
      if (v.role) {
        const { error: rErr } = await supabase.rpc("admin_set_user_role", {
          _user: v.userId,
          _company: v.role === "super_admin" ? null : v.companyId,
          _role: v.role,
        });
        if (rErr) throw rErr;
      }
    },
    onSuccess: () => {
      setErr(null);
      setApproving(null);
      refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("admin_delete_user", { _user: userId });
      if (error) throw error;
    },
    onSuccess: () => {
      setErr(null);
      setDeleting(null);
      refresh();
    },
    onError: fail,
  });

  // Memoised because the two derivations below take it as a dependency, and a
  // fresh [] on every render would rebuild both every time.
  const accounts = useMemo(() => accountsQ.data ?? [], [accountsQ.data]);
  const companies = companiesQ.data ?? [];

  const counts = useMemo(
    () => ({
      all: accounts.length,
      stranded: accounts.filter((a) => !a.company_id && !a.pending_company_id).length,
      pending: accounts.filter((a) => a.pending_company_id).length,
      unconfirmed: accounts.filter((a) => !a.email_confirmed).length,
    }),
    [accounts],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return accounts
      .filter((a) => {
        if (filter === "stranded") return !a.company_id && !a.pending_company_id;
        if (filter === "pending") return !!a.pending_company_id;
        if (filter === "unconfirmed") return !a.email_confirmed;
        return true;
      })
      .filter(
        (a) =>
          !q ||
          a.full_name.toLowerCase().includes(q) ||
          (a.email ?? "").toLowerCase().includes(q) ||
          (a.company_name ?? "").toLowerCase().includes(q),
      );
  }, [accounts, filter, search]);

  if (loading || !isSuper) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const busy = setCompany.isPending || setRole.isPending || approve.isPending;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Accounts</h1>
        <p className="text-sm text-muted-foreground">
          Every sign-in on the platform, including the ones that never reached a company. Place
          them, give them a role, or remove them.
        </p>
      </div>

      {err && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 shadow-sm">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 pl-8"
            placeholder="Search name, email or company…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {(
          [
            ["all", "All"],
            ["stranded", "No company"],
            ["pending", "Awaiting approval"],
            ["unconfirmed", "Email unconfirmed"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              filter === key
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:text-foreground"
            }`}
          >
            {label} ({counts[key]})
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex items-center gap-2 border-b border-border px-5 py-4">
          <Users className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">
            {rows.length} of {accounts.length} account{accounts.length === 1 ? "" : "s"}
          </h2>
        </div>

        {accountsQ.isLoading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : accountsQ.error ? (
          <p className="px-5 py-10 text-center text-sm text-destructive">
            {(accountsQ.error as Error).message}
            <br />
            <span className="text-xs text-muted-foreground">
              If this says the function is missing, the account-administration migration hasn't been
              applied to this database yet.
            </span>
          </p>
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No accounts match.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((a) => {
              const role = (a.roles.find((r) => r !== "supervisor") ?? "") as AppRole | "";
              const isSelf = a.user_id === user?.id;
              // A platform admin belongs to no company by design, so an empty
              // company is not something to fix for them.
              const isPlatformAdmin = a.roles.includes("super_admin");
              return (
                <li key={a.user_id} className="space-y-3 px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                        {a.full_name || "Unnamed"}
                        {isSelf && (
                          <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-normal text-primary">
                            you
                          </span>
                        )}
                        {!a.email_confirmed && (
                          <span className="rounded-full bg-warning/20 px-2 py-0.5 text-[11px] font-normal text-warning-foreground">
                            email unconfirmed
                          </span>
                        )}
                        {!a.has_profile && (
                          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-normal text-destructive">
                            no profile
                          </span>
                        )}
                        {!a.is_active && (
                          <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                            inactive
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {a.email ? (
                          <a href={`mailto:${a.email}`} className="text-primary hover:underline">
                            {a.email}
                          </a>
                        ) : (
                          "no email"
                        )}
                        {" · signed up "}
                        {fmtDate(a.created_at)}
                        {" · last sign-in "}
                        {fmtDate(a.last_sign_in_at)}
                      </p>
                      {a.pending_company_name && (
                        <p className="mt-0.5 text-xs text-warning-foreground">
                          Asking to join {a.pending_company_name}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {/* Two kinds of approval, one button. Someone who asked
                          to join a company is approved into the one they asked
                          for; someone attached to nothing needs a company
                          chosen for them first. */}
                      {a.pending_company_id ? (
                        <Button size="sm" disabled={busy} onClick={() => approve.mutate(a.user_id)}>
                          <UserCheck className="mr-2 h-3.5 w-3.5" />
                          Approve
                        </Button>
                      ) : (
                        !a.company_id &&
                        !isPlatformAdmin && (
                          <Button
                            size="sm"
                            disabled={busy || companies.length === 0}
                            onClick={() => {
                              setErr(null);
                              setApproving(a);
                            }}
                            title={
                              companies.length === 0 ? "There are no companies to approve into" : ""
                            }
                          >
                            <UserCheck className="mr-2 h-3.5 w-3.5" />
                            Approve
                          </Button>
                        )
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isSelf || remove.isPending}
                        className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => {
                          setErr(null);
                          setDeleting(a);
                        }}
                        title={isSelf ? "You cannot delete the account you are signed in with" : ""}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Company</Label>
                      <select
                        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                        value={a.company_id ?? ""}
                        disabled={busy}
                        onChange={(e) =>
                          setCompany.mutate({
                            userId: a.user_id,
                            companyId: e.target.value || null,
                          })
                        }
                      >
                        <option value="">— no company —</option>
                        {companies.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                            {c.status !== "active" ? ` (${c.status})` : ""}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs">Role</Label>
                      <select
                        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                        value={role}
                        disabled={busy}
                        onChange={(e) =>
                          setRole.mutate({
                            userId: a.user_id,
                            companyId: a.company_id,
                            role: (e.target.value || null) as AppRole | null,
                          })
                        }
                      >
                        {ASSIGNABLE.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                      {/* A role is granted inside a company. Saying so beats a
                          rejection from the database after the click. */}
                      {!a.company_id && !isPlatformAdmin && (
                        <p className="text-[11px] text-muted-foreground">
                          Put them in a company first — only Platform Admin works without one.
                        </p>
                      )}
                      {isPlatformAdmin && (
                        <p className="text-[11px] text-muted-foreground">
                          Platform admins run the whole platform and belong to no company.
                        </p>
                      )}
                    </div>
                  </div>

                  {a.roles.length > 1 && (
                    <p className="text-[11px] text-muted-foreground">
                      <ShieldCheck className="mr-1 inline h-3 w-3" />
                      Also holds: {a.roles.map((r) => ROLE_LABEL[r as AppRole] ?? r).join(", ")}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ApproveAccountDialog
        account={approving}
        companies={companies}
        pending={approveInto.isPending}
        onCancel={() => setApproving(null)}
        onConfirm={(companyId, role) =>
          approving && approveInto.mutate({ userId: approving.user_id, companyId, role })
        }
      />

      <DeleteAccountDialog
        account={deleting}
        pending={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.user_id)}
      />
    </div>
  );
}

/**
 * Deleting an account takes their shifts, punches, time off, trades and
 * availability with it — every one of those tables cascades from `auth.users`.
 * There is no undo, so the email has to be typed out.
 */
function DeleteAccountDialog({
  account,
  pending,
  onCancel,
  onConfirm,
}: {
  account: AccountRow | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => setTyped(""), [account?.user_id]);
  const target = account?.email ?? account?.full_name ?? "";
  const matches = typed.trim().toLowerCase() === target.trim().toLowerCase() && target.length > 0;

  return (
    <Dialog open={!!account} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Delete this account
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">
                  {account?.full_name || "Unnamed"}
                </span>{" "}
                ({target}) will be removed from the platform and will not be able to sign in again.
              </p>
              <p>
                Everything scoped to them goes too: shifts, time punches, time off, shift trades
                and availability. Timecards for the period they worked will no longer show them.
                Audit log entries stay, without a name attached.
              </p>
              <p className="font-medium text-foreground">This cannot be undone.</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-account">
            Type <span className="font-mono text-foreground">{target}</span> to confirm
          </Label>
          <Input
            id="confirm-account"
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={!matches || pending}
            onClick={onConfirm}
          >
            {pending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-2 h-4 w-4" />
            )}
            Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Approving an account that belongs to no company: which company, and what they
 * are in it. Both in one dialog because both are the same decision, and neither
 * is useful without the other — a company with no role cannot do anything, and
 * a role with no company is not a role.
 */
function ApproveAccountDialog({
  account,
  companies,
  pending,
  onCancel,
  onConfirm,
}: {
  account: AccountRow | null;
  companies: CompanyLite[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: (companyId: string, role: AppRole | null) => void;
}) {
  const [companyId, setCompanyId] = useState("");
  const [role, setRole] = useState<AppRole | "">("employee");
  // A fresh decision each time this opens, rather than the last one left over.
  useEffect(() => {
    setCompanyId("");
    setRole("employee");
  }, [account?.user_id]);

  return (
    <Dialog open={!!account} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck className="h-5 w-5 text-primary" />
            Approve this account
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">
                  {account?.full_name || "Unnamed"}
                </span>
                {account?.email ? ` (${account.email})` : ""} belongs to no company. Approving puts
                them in one and gives them their role there.
              </p>
              {account && !account.email_confirmed && (
                <p className="text-warning-foreground">
                  Their email address is still unconfirmed — they will not be able to sign in until
                  they confirm it, approved or not.
                </p>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="approve-company">Company</Label>
            <select
              id="approve-company"
              className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
            >
              <option value="">— choose a company —</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.status !== "active" ? ` (${c.status})` : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="approve-role">Role</Label>
            <select
              id="approve-role"
              className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as AppRole | "")}
            >
              {ASSIGNABLE.filter((r) => r.value !== "super_admin").map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              Platform Admin is not granted inside a company — set that from the row's Role list
              instead.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={!companyId || pending}
            onClick={() => onConfirm(companyId, (role || null) as AppRole | null)}
          >
            {pending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <UserCheck className="mr-2 h-4 w-4" />
            )}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
