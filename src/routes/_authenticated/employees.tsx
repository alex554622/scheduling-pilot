import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, ROLE_LABEL, roleLabel, type AppRole } from "@/lib/auth";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useT, translate, useLocaleTag } from "@/lib/i18n";
import { Users, ShieldCheck, Search, Copy, Check, Loader2, UserCog, Trash2, Pencil, Mail, Send, X, Link2, RefreshCw, CalendarClock, Inbox, History, RotateCcw, UserCheck, PauseCircle, PlayCircle } from "lucide-react";
import { shareableOrigin } from "@/lib/native/platform";
import type { VisibilityMode } from "@/lib/staff-visibility";
import { TempPasswordSection } from "@/components/temp-password";
import { ORG_STRUCTURE_KEY, useOrgStructure } from "@/lib/use-org-structure";
import { activeOrCurrent, positionFitsDepartment, positionsForDepartment } from "@/lib/org-structure";

export const Route = createFileRoute("/_authenticated/employees")({
  component: EmployeesPage,
});

type AssignableRole = Exclude<AppRole, "super_admin">;
const ASSIGNABLE_ROLES: AssignableRole[] = ["company_admin", "supervisor", "employee"];
/**
 * An invitation can't carry "supervisor": accept_invitation still turns that
 * old value into company_admin. Invite them as an employee, then make them a
 * supervisor from the roster once they are in.
 */
const INVITE_ROLES: AssignableRole[] = ["company_admin", "employee"];

interface MemberRow {
  id: string;
  full_name: string;
  position: string | null;
  position_id?: string | null;
  department_id?: string | null;
}

type SeparationReason = "rehire" | "laid_off" | "other";

const SEPARATION_REASONS: { value: SeparationReason; label: string; hint: string }[] = [
  {
    value: "rehire",
    label: "Eligible for rehire",
    hint: "Left in good standing — can be brought back.",
  },
  { value: "laid_off", label: "Laid off", hint: "Position ended. Still eligible to return." },
  { value: "other", label: "Other", hint: "Record the reason in the note below." },
];

const REASON_LABEL: Record<SeparationReason, string> = {
  rehire: "Eligible for rehire",
  laid_off: "Laid off",
  other: "Other",
};

interface RemoveArgs {
  userId: string;
  reason: SeparationReason;
  note: string;
}

interface SeparationRow {
  id: string;
  user_id: string;
  reason: SeparationReason;
  note: string | null;
  separated_at: string;
  prior_full_name: string;
  prior_position: string | null;
}

function EmployeesPage() {
  const t = useT("people");
  const { primaryRole, company, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && primaryRole && primaryRole !== "company_admin" && primaryRole !== "super_admin") {
      navigate({ to: "/dashboard" });
    }
  }, [loading, primaryRole, navigate]);

  if (loading) return <div className="text-sm text-muted-foreground">{t("Loading…")}</div>;
  if (!primaryRole || (primaryRole !== "company_admin" && primaryRole !== "super_admin")) {
    return <div className="text-sm text-muted-foreground">{t("You don't have access to this page.")}</div>;
  }
  if (!company) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
        {t("You need to belong to a company before managing employees.")}
      </div>
    );
  }
  return <Roster companyId={company.id} companyName={company.name} joinCode={company.join_code} />;
}

function Roster({
  companyId,
  companyName,
  joinCode,
}: {
  companyId: string;
  companyName: string;
  joinCode: string | null;
}) {
  const t = useT("people");
  const qc = useQueryClient();
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState<MemberRow | null>(null);
  // Ticked rows, for giving several people the same settings at once.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removing, setRemoving] = useState<MemberRow | null>(null);
  // The supervisor whose departments are being chosen.
  const [scoping, setScoping] = useState<MemberRow | null>(null);
  const org = useOrgStructure(companyId);
  const departmentName = (id: string | null | undefined) =>
    org.departments.find((d) => d.id === id)?.name ?? null;

  const membersQ = useQuery({
    queryKey: ["company-members", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("company_members")
        .select("id, full_name, position, position_id, department_id")
        .eq("company_id", companyId)
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as MemberRow[];
    },
  });

  const rolesQ = useQuery({
    queryKey: ["company-roles", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .eq("company_id", companyId);
      if (error) throw error;
      return (data ?? []) as { user_id: string; role: AppRole }[];
    },
  });

  // Former employees. The profile rows are unreadable once company_id is null
  // (profile_view is company-scoped), so the display fields come from the
  // snapshot taken at separation rather than from a join.
  const separationsQ = useQuery({
    queryKey: ["company-separations", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employment_separations")
        .select("id, user_id, reason, note, separated_at, prior_full_name, prior_position")
        .eq("company_id", companyId)
        .is("rehired_at", null)
        .order("separated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as SeparationRow[];
    },
  });

  const rolesByUser = useMemo(() => {
    const map = new Map<string, AppRole[]>();
    (rolesQ.data ?? []).forEach((r) => {
      const arr = map.get(r.user_id) ?? [];
      arr.push(r.role);
      map.set(r.user_id, arr);
    });
    return map;
  }, [rolesQ.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return membersQ.data ?? [];
    return (membersQ.data ?? []).filter(
      (m) => m.full_name.toLowerCase().includes(q) || (m.position ?? "").toLowerCase().includes(q),
    );
  }, [membersQ.data, search]);

  // Only people still on the roster count as picked: someone removed while
  // ticked must not be edited by a bulk save.
  const picked = (membersQ.data ?? []).filter((m) => selected.has(m.id));
  const allShownPicked = filtered.length > 0 && filtered.every((m) => selected.has(m.id));
  function togglePick(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function togglePickAllShown() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allShownPicked) filtered.forEach((m) => next.delete(m.id));
      else filtered.forEach((m) => next.add(m.id));
      return next;
    });
  }

  const setRoleMut = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: AssignableRole }) => {
      // One role per company; the server keeps at least one admin and logs it.
      const { error } = await supabase.rpc("set_member_role", { _user: userId, _role: role });
      if (error) throw error;
      // No longer a supervisor: their departments go with the role, so making
      // them one again later starts from nothing rather than old reach.
      if (role !== "supervisor") {
        const { error: scopeErr } = await supabase
          .from("supervisor_assignments")
          .delete()
          .eq("supervisor_id", userId)
          .eq("company_id", companyId);
        if (scopeErr) throw scopeErr;
      }
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["company-roles", companyId] });
      qc.invalidateQueries({ queryKey: ["supervisor-assignments", companyId] });
      // A new supervisor has no departments yet; take the admin straight there.
      if (v.role === "supervisor") {
        const m = (membersQ.data ?? []).find((x) => x.id === v.userId);
        if (m) setScoping(m);
      }
    },
  });

  // Every supervisor's departments, for the line under their name.
  const assignmentsQ = useQuery({
    queryKey: ["supervisor-assignments", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("supervisor_assignments")
        .select("supervisor_id, department_id, employee_id, departments(name)")
        .eq("company_id", companyId);
      if (error) throw error;
      return data ?? [];
    },
  });

  const scopeSummary = useMemo(() => {
    const map = new Map<string, Map<string, { name: string; narrowed: boolean }>>();
    for (const a of assignmentsQ.data ?? []) {
      const byDept = map.get(a.supervisor_id) ?? new Map();
      const prev = byDept.get(a.department_id);
      const name = (a.departments as { name: string } | null)?.name ?? "?";
      // A whole-department row wins over named people in the same department.
      byDept.set(a.department_id, {
        name,
        narrowed: a.employee_id !== null && (prev ? prev.narrowed : true),
      });
      map.set(a.supervisor_id, byDept);
    }
    return map;
  }, [assignmentsQ.data]);

  const removeMut = useMutation({
    mutationFn: async ({ userId, reason, note }: RemoveArgs) => {
      // Clearing roles and profile.company_id from here needs two statements, and
      // RLS rejects the second: profile_admin_update's WITH CHECK sees the new row
      // with a null company_id and fails it. The definer RPC authorizes the caller
      // itself and does every write in one transaction, including the separation
      // record that makes the person rehirable.
      const { error } = await supabase.rpc("remove_company_member", {
        _user: userId,
        _reason: reason,
        _note: note.trim() || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-members", companyId] });
      qc.invalidateQueries({ queryKey: ["company-roles", companyId] });
      qc.invalidateQueries({ queryKey: ["company-separations", companyId] });
      setRemoving(null);
    },
  });

  const suspendedQ = useQuery({
    queryKey: ["company-suspended", companyId],
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("company_memberships")
        .select("user_id, status_reason, status_changed_at")
        .eq("company_id", companyId)
        .eq("status", "suspended")
        .order("status_changed_at", { ascending: false });
      if (error) throw error;
      const ids = (rows ?? []).map((q) => q.user_id);
      if (ids.length === 0) return [] as SuspendedRow[];
      const { data: people, error: pErr } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", ids);
      if (pErr) throw pErr;
      const names = new Map((people ?? []).map((p) => [p.id, p.full_name]));
      return (rows ?? []).map((q) => ({
        id: q.user_id,
        full_name: names.get(q.user_id) ?? "",
        reason: q.status_reason,
        since: q.status_changed_at,
      }));
    },
  });

  const suspendMut = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("suspend_membership", { _user: userId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-members", companyId] });
      qc.invalidateQueries({ queryKey: ["company-suspended", companyId] });
    },
  });

  const reinstateMut = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("reinstate_membership", { _user: userId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-members", companyId] });
      qc.invalidateQueries({ queryKey: ["company-suspended", companyId] });
    },
  });

  const rehireMut = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("rehire_company_member", { _user: userId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-members", companyId] });
      qc.invalidateQueries({ queryKey: ["company-roles", companyId] });
      qc.invalidateQueries({ queryKey: ["company-separations", companyId] });
    },
  });

  // Permanent delete: drops the separation record, which takes the person out
  // of Former employees and removes the one-click rehire with them. Their
  // account is untouched — it is theirs, not the company's — so they can still
  // be taken on again later with the company code.
  const forgetMut = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("forget_former_member", { _user: userId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["company-separations", companyId] }),
  });

  // ---------- Pending join requests ----------
  const joinRequestsQ = useQuery({
    queryKey: ["company-join-requests", companyId],
    queryFn: async () => {
      const { data: reqs, error } = await supabase
        .from("company_join_requests")
        .select("user_id, message")
        .eq("company_id", companyId)
        .eq("status", "pending")
        .order("created_at");
      if (error) throw error;
      const ids = (reqs ?? []).map((q) => q.user_id);
      if (ids.length === 0) return [] as MemberRow[];
      const { data: people, error: pErr } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", ids);
      if (pErr) throw pErr;
      const names = new Map((people ?? []).map((p) => [p.id, p.full_name]));
      return (reqs ?? []).map((q) => ({
        id: q.user_id,
        full_name: names.get(q.user_id) ?? "",
        position: q.message,
      })) as MemberRow[];
    },
  });

  const approveJoinMut = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("approve_membership", { _user: userId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-join-requests", companyId] });
      qc.invalidateQueries({ queryKey: ["company-members", companyId] });
      qc.invalidateQueries({ queryKey: ["company-roles", companyId] });
    },
  });

  const rejectJoinMut = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("reject_membership", { _user: userId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["company-join-requests", companyId] }),
  });

  interface InviteRow {
    id: string;
    email: string;
    role: AssignableRole;
    token: string;
    status: string;
    expires_at: string;
    created_at: string;
  }

  const invitesQ = useQuery({
    queryKey: ["company-invites", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invitations")
        .select("id, email, role, token, status, expires_at, created_at")
        .eq("company_id", companyId)
        .eq("status", "pending")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as InviteRow[];
    },
  });

  const createInviteMut = useMutation({
    mutationFn: async ({ email, role }: { email: string; role: AssignableRole }) => {
      if (!user) throw new Error(translate("Not authenticated"));
      const { data, error } = await supabase
        .from("invitations")
        .insert({
          company_id: companyId,
          email: email.trim().toLowerCase(),
          role,
          invited_by: user.id,
        })
        .select("token")
        .single();
      if (error) throw error;
      return data as { token: string };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["company-invites", companyId] }),
  });

  const revokeInviteMut = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("invitations")
        .update({ status: "revoked" })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["company-invites", companyId] }),
  });

  const extendInviteMut = useMutation({
    mutationFn: async ({ id, regenerate }: { id: string; regenerate: boolean }) => {
      const expires_at = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const patch: { expires_at: string; status: string; token?: string } = {
        expires_at,
        status: "pending",
      };
      if (regenerate) patch.token = crypto.randomUUID();
      const { error } = await supabase
        .from("invitations")
        .update(patch)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["company-invites", companyId] }),
  });

  // Signup feeds this straight into join_company_by_code, which matches on
  // companies.join_code — the company UUID is not interchangeable with it.
  const copyJoinCode = async () => {
    if (!joinCode) return;
    await navigator.clipboard.writeText(joinCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const counts = useMemo(() => {
    const c = { company_admin: 0, supervisor: 0, employee: 0, none: 0 };
    (membersQ.data ?? []).forEach((m) => {
      const rs = rolesByUser.get(m.id) ?? [];
      if (rs.includes("company_admin")) c.company_admin++;
      else if (rs.includes("supervisor")) c.supervisor++;
      else if (rs.includes("employee")) c.employee++;
      else c.none++;
    });
    return c;
  }, [membersQ.data, rolesByUser]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">{t("Employees")}</h2>
          <p className="text-sm text-muted-foreground">{t("Manage the roster and assign roles for {companyName}.", { companyName })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
            {joinCode ? (
              <>
                {t("Join code:")}{" "}
                <span className="font-mono tracking-widest text-foreground">{joinCode}</span>
              </>
            ) : (
              t("Join code available once your company is approved")
            )}
          </div>
          {joinCode && (
            <Button variant="outline" size="sm" onClick={copyJoinCode}>
              {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
              {copied ? t("Copied") : t("Copy join code")}
            </Button>
          )}
          <Link
            to="/employees/join-requests"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent"
          >
            <Inbox className="h-3.5 w-3.5" />
            {t("Join requests")}
            {(joinRequestsQ.data?.length ?? 0) > 0 && (
              <span className="ml-1 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
                {joinRequestsQ.data!.length}
              </span>
            )}
          </Link>
          <Button size="sm" onClick={() => setInviteOpen(true)}>
            <Send className="mr-1.5 h-3.5 w-3.5" /> {t("Invite teammate")}
          </Button>
        </div>
      </div>

      <PendingInvitesCard
        invites={invitesQ.data ?? []}
        loading={invitesQ.isLoading}
        revoking={revokeInviteMut}
        extending={extendInviteMut}
        companyName={companyName}
      />

      <JoinRequestsCard
        requests={joinRequestsQ.data ?? []}
        loading={joinRequestsQ.isLoading}
        approving={approveJoinMut}
        rejecting={rejectJoinMut}
      />



      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatCard label={t("Total members")} value={(membersQ.data ?? []).length} icon={Users} />
        <StatCard label={t("Admins")} value={counts.company_admin} icon={ShieldCheck} />
        <StatCard label={t("Supervisors")} value={counts.supervisor} icon={UserCheck} />
        <StatCard label={t("Employees")} value={counts.employee} icon={Users} />
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border p-3">
          <input
            type="checkbox"
            className="h-4 w-4 shrink-0"
            checked={allShownPicked}
            disabled={filtered.length === 0}
            onChange={togglePickAllShown}
            aria-label={t("Select everyone shown")}
            title={t("Select everyone shown")}
          />
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("Search by name or position…")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 border-0 shadow-none focus-visible:ring-0"
          />
        </div>

        {picked.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-primary-soft/40 px-3 py-2 text-sm">
            <span className="font-medium text-foreground">
              {picked.length === 1 ? t("1 selected") : t("{n} selected", { n: picked.length })}
            </span>
            <Button size="sm" onClick={() => setBulkOpen(true)}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" /> {t("Edit selected")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              {t("Clear")}
            </Button>
          </div>
        )}

        {membersQ.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">{t("Loading roster…")}</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            {search ? t("No matches.") : t("No members yet. Share your company ID so teammates can join.")}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((m) => {
              const userRoles = rolesByUser.get(m.id) ?? [];
              const current: AssignableRole =
                (ASSIGNABLE_ROLES.find((r) => userRoles.includes(r)) as AssignableRole | undefined) ?? "employee";
              const initials =
                m.full_name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase() || "?";
              const busy =
                (setRoleMut.isPending && setRoleMut.variables?.userId === m.id) ||
                (removeMut.isPending && removeMut.variables?.userId === m.id) ||
                (suspendMut.isPending && suspendMut.variables === m.id);
              return (
                <div key={m.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0"
                      checked={selected.has(m.id)}
                      onChange={() => togglePick(m.id)}
                      aria-label={t("Select {name}", { name: m.full_name || t("Unnamed") })}
                    />
                    <div className="grid h-10 w-10 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary">
                      {initials}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{m.full_name || t("Unnamed")}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {[m.position, departmentName(m.department_id)].filter(Boolean).join(" · ") ||
                          t("No position set")}
                      </p>
                      {current === "supervisor" && (
                        <p className="truncate text-xs text-primary">
                          {(() => {
                            const depts = [...(scopeSummary.get(m.id)?.values() ?? [])];
                            if (depts.length === 0) return t("Supervises: no departments yet");
                            return t("Supervises: {list}", {
                              list: depts
                                .map((d) => (d.narrowed ? t("{name} (some people)", { name: d.name }) : d.name))
                                .join(", "),
                            });
                          })()}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={current}
                      // Nobody changes their own role: an admin who picks
                      // anything else locks themselves out of this page.
                      disabled={busy || m.id === user?.id}
                      title={m.id === user?.id ? t("You can't change your own role.") : undefined}
                      onChange={(e) =>
                        setRoleMut.mutate({ userId: m.id, role: e.target.value as AssignableRole })
                      }
                      className="h-9 rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {ASSIGNABLE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {t(ROLE_LABEL[r])}
                        </option>
                      ))}
                    </select>
                    {current === "supervisor" && (
                      <Button variant="outline" size="sm" onClick={() => setScoping(m)} disabled={busy}>
                        <UserCheck className="mr-1.5 h-3.5 w-3.5" /> {t("Departments")}
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => setEditing(m)} disabled={busy}>
                      <Pencil className="mr-1.5 h-3.5 w-3.5" /> {t("Edit")}
                    </Button>
                    {m.id !== user?.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        title={t("Suspend access to this company")}
                        onClick={() => {
                          if (
                            window.confirm(
                              t("Suspend {name}? They lose access to {companyName} right away. Their other companies are not affected.", {
                                name: m.full_name || t("this member"),
                                companyName,
                              }),
                            )
                          )
                            suspendMut.mutate(m.id);
                        }}
                      >
                        <PauseCircle className="h-3.5 w-3.5" />
                        <span className="sr-only sm:not-sr-only sm:ml-1.5">{t("Suspend")}</span>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      disabled={busy}
                      onClick={() => setRemoving(m)}
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {(setRoleMut.error || removeMut.error || rehireMut.error || suspendMut.error || reinstateMut.error) && (
        <p className="text-sm text-destructive">
          {(setRoleMut.error as Error)?.message ||
            (removeMut.error as Error)?.message ||
            (rehireMut.error as Error)?.message ||
            (suspendMut.error as Error)?.message ||
            (reinstateMut.error as Error)?.message}
        </p>
      )}

      <SuspendedMembersCard
        rows={suspendedQ.data ?? []}
        onReinstate={(userId) => reinstateMut.mutate(userId)}
        pendingId={reinstateMut.isPending ? (reinstateMut.variables as string) : null}
      />

      <FormerEmployeesCard
        rows={separationsQ.data ?? []}
        loading={separationsQ.isLoading}
        companyName={companyName}
        onRehire={(userId) => rehireMut.mutate(userId)}
        pendingId={rehireMut.isPending ? (rehireMut.variables as string) : null}
        onForget={(userId) => forgetMut.mutate(userId)}
        forgettingId={forgetMut.isPending ? (forgetMut.variables as string) : null}
      />

      <RemoveMemberDialog
        member={removing}
        companyName={companyName}
        busy={removeMut.isPending}
        error={(removeMut.error as Error)?.message ?? null}
        onClose={() => {
          removeMut.reset();
          setRemoving(null);
        }}
        onConfirm={(reason, note) => removeMut.mutate({ userId: removing!.id, reason, note })}
      />

      <SupervisorScopeDialog
        supervisor={scoping}
        companyId={companyId}
        onClose={() => setScoping(null)}
        onSaved={() => {
          setScoping(null);
          qc.invalidateQueries({ queryKey: ["supervisor-assignments", companyId] });
        }}
      />

      <EditMemberDialog
        member={editing}
        companyId={companyId}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          qc.invalidateQueries({ queryKey: ["company-members", companyId] });
        }}
      />

      <BulkEditDialog
        open={bulkOpen}
        members={picked}
        companyId={companyId}
        onClose={() => setBulkOpen(false)}
        onSaved={() => {
          setBulkOpen(false);
          setSelected(new Set());
          qc.invalidateQueries({ queryKey: ["company-members", companyId] });
          qc.invalidateQueries({ queryKey: ["member-profile"] });
          qc.invalidateQueries({ queryKey: ["employee-locations"] });
          qc.invalidateQueries({ queryKey: ["member-visibility"] });
          qc.invalidateQueries({ queryKey: ["member-visibility-one"] });
        }}
      />

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        existingEmails={(invitesQ.data ?? []).map((i) => i.email.toLowerCase())}
        companyName={companyName}
        createInvite={createInviteMut.mutateAsync}
      />
    </div>
  );
}

function RemoveMemberDialog({
  member,
  companyName,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  member: MemberRow | null;
  companyName: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (reason: SeparationReason, note: string) => void;
}) {
  const t = useT("people");
  const [reason, setReason] = useState<SeparationReason>("rehire");
  const [note, setNote] = useState("");

  // Reset per member, so a reason picked for one person is never carried into
  // the next removal.
  useEffect(() => {
    if (member) {
      setReason("rehire");
      setNote("");
    }
  }, [member]);

  return (
    <Dialog open={!!member} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Remove {name}", { name: member?.full_name || t("member") })}</DialogTitle>
          <DialogDescription>
            {t("This removes them from {companyName} and frees their seat. Their account is kept, so you can rehire them later, and they can join another company with that company's join code.", { companyName })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("Reason")}</Label>
            <div className="space-y-2">
              {SEPARATION_REASONS.map((r) => (
                <label
                  key={r.value}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors ${
                    reason === r.value
                      ? "border-primary bg-primary-soft"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <input
                    type="radio"
                    name="separation-reason"
                    className="mt-0.5"
                    checked={reason === r.value}
                    onChange={() => setReason(r.value)}
                    disabled={busy}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">{t(r.label)}</span>
                    <span className="block text-xs text-muted-foreground">{t(r.hint)}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="separation-note">
              {t("Note")} {reason === "other" && <span className="text-destructive">*</span>}
            </Label>
            <Input
              id="separation-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("Optional context for the record")}
              disabled={busy}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={() => onConfirm(reason, note)}
            disabled={busy || (reason === "other" && !note.trim())}
          >
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {t("Remove from company")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FormerEmployeesCard({
  rows,
  loading,
  companyName,
  onRehire,
  pendingId,
  onForget,
  forgettingId,
}: {
  rows: SeparationRow[];
  loading: boolean;
  companyName: string;
  onRehire: (userId: string) => void;
  pendingId: string | null;
  onForget: (userId: string) => void;
  forgettingId: string | null;
}) {
  const t = useT("people");
  const tag = useLocaleTag();
  if (loading || rows.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border p-4">
        <History className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold text-foreground">{t("Former employees")}</h2>
        <span className="text-xs text-muted-foreground">({rows.length})</span>
      </div>
      <div className="divide-y divide-border">
        {rows.map((s) => {
          const busy = pendingId === s.user_id;
          const forgetting = forgettingId === s.user_id;
          return (
            <div
              key={s.id}
              className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">
                  {s.prior_full_name || t("Unnamed")}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {t(REASON_LABEL[s.reason])}
                  {s.prior_position ? ` · ${s.prior_position}` : ""} · {t("left {date}", { date: new Date(s.separated_at).toLocaleDateString(tag) })}
                </p>
                {s.note && (
                  <p className="mt-1 truncate text-xs text-muted-foreground italic">{s.note}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || forgetting}
                  onClick={() => {
                    if (
                      confirm(t("Rehire {name} into {companyName}?", { name: s.prior_full_name || t("this person"), companyName }))
                    ) {
                      onRehire(s.user_id);
                    }
                  }}
                >
                  {busy ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {t("Rehire")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={busy || forgetting}
                  onClick={() => {
                    if (
                      confirm(
                        t("Delete {name} from {companyName} for good?\n\nThey leave this list and can no longer be rehired with one click. Their own account stays, and they can join again with the company code. This cannot be undone.", { name: s.prior_full_name || t("this person"), companyName }),
                      )
                    ) {
                      onForget(s.user_id);
                    }
                  }}
                >
                  {forgetting ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {t("Delete permanently")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PendingInvitesCard({
  invites,
  loading,
  revoking,
  extending,
  companyName,
}: {
  invites: { id: string; email: string; role: AssignableRole; token: string; expires_at: string }[];
  loading: boolean;
  revoking: { mutate: (id: string) => void; isPending: boolean; variables?: string };
  extending: {
    mutate: (args: { id: string; regenerate: boolean }) => void;
    isPending: boolean;
    variables?: { id: string; regenerate: boolean };
  };
  companyName: string;
}) {
  const t = useT("people");
  const tag = useLocaleTag();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  if (loading) return null;
  if (invites.length === 0) return null;

  const joinUrl = (token: string) =>
    `${shareableOrigin()}/join?token=${token}`;

  const copy = async (token: string, id: string) => {
    await navigator.clipboard.writeText(joinUrl(token));
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">{t("Pending invitations")}</h3>
          <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary">
            {invites.length}
          </span>
        </div>
      </div>
      <div className="divide-y divide-border">
        {invites.map((inv) => {
          const expired = new Date(inv.expires_at) < new Date();
          const busy = revoking.isPending && revoking.variables === inv.id;
          const extendBusy = extending.isPending && extending.variables?.id === inv.id;
          const regenBusy = extendBusy && extending.variables?.regenerate === true;
          const justExtendBusy = extendBusy && extending.variables?.regenerate === false;
          const subject = encodeURIComponent(t("You're invited to join {companyName}", { companyName }));
          const body = encodeURIComponent(
            t("You've been invited to join {companyName} as {role}.\n\nAccept your invitation:\n{url}\n\nThis link expires on {date}.", {
              companyName,
              role: t(roleLabel(inv.role)),
              url: joinUrl(inv.token),
              date: new Date(inv.expires_at).toLocaleDateString(tag),
            }),
          );
          return (
            <div key={inv.id} className="flex flex-col gap-2 p-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{inv.email}</p>
                <p className="text-xs text-muted-foreground">
                  {t(roleLabel(inv.role))} ·{" "}
                  {expired ? (
                    <span className="text-destructive">{t("Expired")}</span>
                  ) : (
                    <>{t("Expires {date}", { date: new Date(inv.expires_at).toLocaleDateString(tag) })}</>
                  )}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => copy(inv.token, inv.id)}>
                  {copiedId === inv.id ? (
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                  ) : (
                    <Link2 className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {copiedId === inv.id ? t("Copied") : t("Copy link")}
                </Button>
                <a
                  href={`mailto:${inv.email}?subject=${subject}&body=${body}`}
                  className="inline-flex h-9 items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-accent"
                >
                  <Send className="mr-1.5 h-3.5 w-3.5" /> {t("Email")}
                </a>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={extendBusy}
                  onClick={() => extending.mutate({ id: inv.id, regenerate: false })}
                  title={t("Extend expiration by 14 days")}
                >
                  {justExtendBusy ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CalendarClock className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {t("Extend")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={extendBusy}
                  onClick={() => {
                    if (
                      confirm(
                        t("Regenerate the invite link for {email}? The previous link will stop working.", { email: inv.email }),
                      )
                    ) {
                      extending.mutate({ id: inv.id, regenerate: true });
                    }
                  }}
                  title={t("Generate a new link and reset expiration")}
                >
                  {regenBusy ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {t("Regenerate")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(t("Revoke invitation to {email}?", { email: inv.email }))) revoking.mutate(inv.id);
                  }}
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InviteDialog({
  open,
  onClose,
  existingEmails,
  companyName,
  createInvite,
}: {
  open: boolean;
  onClose: () => void;
  existingEmails: string[];
  companyName: string;
  createInvite: (args: { email: string; role: AssignableRole }) => Promise<{ token: string }>;
}) {
  const t = useT("people");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("employee");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string; email: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setEmail("");
      setRole("employee");
      setErr(null);
      setCreated(null);
      setCopied(false);
    }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setErr(t("Enter a valid email address."));
      return;
    }
    if (existingEmails.includes(trimmed)) {
      setErr(t("There is already a pending invitation for this email."));
      return;
    }
    setBusy(true);
    try {
      const { token } = await createInvite({ email: trimmed, role });
      setCreated({ token, email: trimmed });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const joinUrl = created ? `${shareableOrigin()}/join?token=${created.token}` : "";
  const subject = created ? encodeURIComponent(t("You're invited to join {companyName}", { companyName })) : "";
  const body = created
    ? encodeURIComponent(
        t("You've been invited to join {companyName} as {role}.\n\nAccept your invitation:\n{url}", {
          companyName,
          role: t(ROLE_LABEL[role]),
          url: joinUrl,
        }),
      )
    : "";

  async function copyLink() {
    await navigator.clipboard.writeText(joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{created ? t("Invitation ready") : t("Invite a teammate")}</DialogTitle>
          <DialogDescription>
            {created
              ? t("Share the join link below with your teammate. It expires in 14 days.")
              : t("We'll create a join link with their role pre-assigned.")}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3">
            <div>
              <Label>{t("Recipient")}</Label>
              <Input readOnly value={created.email} />
            </div>
            <div>
              <Label>{t("Join link")}</Label>
              <Input readOnly value={joinUrl} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={copyLink}>
                {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
                {copied ? t("Copied") : t("Copy link")}
              </Button>
              <a
                href={`mailto:${created.email}?subject=${subject}&body=${body}`}
                className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                <Send className="mr-1.5 h-3.5 w-3.5" /> {t("Open email")}
              </a>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <Label htmlFor="invite-email">{t("Email")}</Label>
              <Input
                id="invite-email"
                type="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@example.com"
                maxLength={254}
                required
              />
            </div>
            <div>
              <Label htmlFor="invite-role">{t("Role")}</Label>
              <select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value as AssignableRole)}
                className="mt-1 h-10 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {INVITE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(ROLE_LABEL[r])}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("To make someone a supervisor, invite them as an employee, then change their role on the roster.")}
              </p>
            </div>
            {err && <p className="text-sm text-destructive">{err}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {t("Create invitation")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Which departments a supervisor runs, and optionally which people in each.
 *
 * Saved as `supervisor_assignments` rows: one with no employee for a whole
 * department, or one per person when only some of it is theirs. The database
 * reads these rows on every request (`supervises()`), so what is saved here is
 * exactly what the supervisor can reach.
 */
function SupervisorScopeDialog({
  supervisor,
  companyId,
  onClose,
  onSaved,
}: {
  supervisor: MemberRow | null;
  companyId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT("people");
  // department id → "all" for the whole department, or the people picked in it
  const [scope, setScope] = useState<Map<string, "all" | Set<string>>>(new Map());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const open = !!supervisor;

  const departmentsQ = useQuery({
    queryKey: ["departments", companyId, "with-description"],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("departments")
        .select("id, name, description")
        .eq("company_id", companyId)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const peopleQ = useQuery({
    queryKey: ["company-members-departments", companyId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        // A person's department is per company, so read it from their
        // membership here, not from their profile.
        .from("company_members")
        .select("id, full_name, department_id")
        .eq("company_id", companyId)
        .eq("status", "active")
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const currentQ = useQuery({
    queryKey: ["supervisor-assignments-one", supervisor?.id],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("supervisor_assignments")
        .select("department_id, employee_id")
        .eq("supervisor_id", supervisor!.id)
        .eq("company_id", companyId);
      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    if (!currentQ.data) return;
    const next = new Map<string, "all" | Set<string>>();
    for (const a of currentQ.data) {
      const prev = next.get(a.department_id);
      if (a.employee_id === null || prev === "all") next.set(a.department_id, "all");
      else next.set(a.department_id, new Set([...(prev ?? []), a.employee_id]));
    }
    setScope(next);
    setErr(null);
  }, [currentQ.data]);

  function toggleDepartment(id: string) {
    setScope((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, "all");
      return next;
    });
  }

  function setMode(id: string, mode: "all" | "some") {
    setScope((prev) => new Map(prev).set(id, mode === "all" ? "all" : new Set()));
  }

  function togglePerson(deptId: string, personId: string) {
    setScope((prev) => {
      const cur = prev.get(deptId);
      const picked = new Set(cur instanceof Set ? cur : []);
      if (picked.has(personId)) picked.delete(personId);
      else picked.add(personId);
      return new Map(prev).set(deptId, picked);
    });
  }

  // A "some people" department with nobody ticked would quietly give no reach.
  const emptyPick = [...scope.values()].some((v) => v instanceof Set && v.size === 0);

  async function save() {
    if (!supervisor) return;
    setSaving(true);
    setErr(null);
    const rows: { company_id: string; supervisor_id: string; department_id: string; employee_id: string | null }[] = [];
    for (const [deptId, v] of scope) {
      if (v === "all") {
        rows.push({ company_id: companyId, supervisor_id: supervisor.id, department_id: deptId, employee_id: null });
      } else {
        for (const pid of v) {
          rows.push({ company_id: companyId, supervisor_id: supervisor.id, department_id: deptId, employee_id: pid });
        }
      }
    }
    const { error: delErr } = await supabase
      .from("supervisor_assignments")
      .delete()
      .eq("supervisor_id", supervisor.id)
      .eq("company_id", companyId);
    if (delErr) {
      setSaving(false);
      setErr(delErr.message);
      return;
    }
    if (rows.length) {
      const { error: insErr } = await supabase.from("supervisor_assignments").insert(rows);
      if (insErr) {
        setSaving(false);
        setErr(insErr.message);
        return;
      }
    }
    setSaving(false);
    onSaved();
  }

  const departments = departmentsQ.data ?? [];
  const people = (peopleQ.data ?? []).filter((p) => p.id !== supervisor?.id);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("{name}'s departments", { name: supervisor?.full_name || t("Supervisor") })}
          </DialogTitle>
          <DialogDescription>
            {t("A supervisor sees and manages only the people in these departments: their schedules, timecards, time off and reports. Company settings stay with admins.")}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {departmentsQ.isLoading || currentQ.isLoading ? (
            <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
          ) : departments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("No departments yet — add them on Settings → Organization → Departments.")}
            </p>
          ) : (
            departments.map((d) => {
              const v = scope.get(d.id);
              const inDept = people.filter((p) => p.department_id === d.id);
              return (
                <div key={d.id} className="rounded-lg border border-border p-3">
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4"
                      checked={!!v}
                      onChange={() => toggleDepartment(d.id)}
                      disabled={saving}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">{d.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {inDept.length === 1
                          ? t("1 person")
                          : t("{n} people", { n: inDept.length })}
                        {d.description ? ` · ${d.description}` : ""}
                      </span>
                    </span>
                  </label>
                  {v && (
                    <div className="mt-2 space-y-2 pl-6">
                      <div className="flex flex-wrap gap-3 text-sm">
                        <label className="flex items-center gap-1.5">
                          <input
                            type="radio"
                            name={`mode-${d.id}`}
                            checked={v === "all"}
                            onChange={() => setMode(d.id, "all")}
                            disabled={saving}
                          />
                          {t("Everyone in it")}
                        </label>
                        <label className="flex items-center gap-1.5">
                          <input
                            type="radio"
                            name={`mode-${d.id}`}
                            checked={v !== "all"}
                            onChange={() => setMode(d.id, "some")}
                            disabled={saving}
                          />
                          {t("Only some people")}
                        </label>
                      </div>
                      {v !== "all" &&
                        (inDept.length === 0 ? (
                          <p className="text-xs text-muted-foreground">{t("Nobody is in this department yet.")}</p>
                        ) : (
                          <div className="grid gap-1 sm:grid-cols-2">
                            {inDept.map((p) => (
                              <label key={p.id} className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4"
                                  checked={v.has(p.id)}
                                  onChange={() => togglePerson(d.id, p.id)}
                                  disabled={saving}
                                />
                                <span className="truncate">{p.full_name || t("Unnamed")}</span>
                              </label>
                            ))}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
          {err && <p className="text-sm text-destructive">{err}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("Cancel")}
          </Button>
          <Button onClick={save} disabled={saving || emptyPick || currentQ.isLoading}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatCard({ label, value, icon: Icon }: { label: string; value: number; icon: typeof Users }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="mt-2 text-2xl font-semibold text-foreground">{value}</p>
    </div>
  );
}

function EditMemberDialog({
  member,
  companyId,
  onClose,
  onSaved,
}: {
  member: MemberRow | null;
  companyId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT("people");
  const [fullName, setFullName] = useState("");
  // A job title typed before positions were picked from a list. It shows
  // until an admin picks a position.
  const [legacyTitle, setLegacyTitle] = useState("");
  // Work location, department and position, all from Settings → Organization.
  // The schedule builder can divide its rows by department.
  const [locationId, setLocationId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [positionId, setPositionId] = useState("");
  const org = useOrgStructure(companyId, !!member);
  const [maxHours, setMaxHours] = useState<number>(40);
  const [isActive, setIsActive] = useState(true);
  const [worksAt, setWorksAt] = useState<Set<string>>(new Set());
  // Where they show up; "" is the company default.
  const [visibility, setVisibility] = useState<VisibilityMode | "">("");
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Who supervises them: whoever has their department, whole or by name.
  // Supervisors are given departments from the roster, not here.
  const supervisorsQ = useQuery({
    queryKey: ["supervisor-assignments", companyId, "names"],
    enabled: !!member,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("supervisor_assignments")
        .select("supervisor_id, department_id, employee_id")
        .eq("company_id", companyId);
      if (error || !data?.length) return { assignments: [], names: new Map<string, string>() };
      const ids = [...new Set(data.map((a) => a.supervisor_id))];
      const { data: people } = await supabase
        .from("company_members")
        .select("id, full_name")
        .eq("company_id", companyId)
        .in("id", ids);
      return {
        assignments: data,
        names: new Map((people ?? []).map((p) => [p.id, p.full_name || ""])),
      };
    },
  });
  const supervisorNames = useMemo(() => {
    if (!member || !departmentId || !supervisorsQ.data) return [];
    const { assignments, names } = supervisorsQ.data;
    return [
      ...new Set(
        assignments
          .filter(
            (a) =>
              a.department_id === departmentId &&
              a.supervisor_id !== member.id &&
              (a.employee_id === null || a.employee_id === member.id),
          )
          .map((a) => names.get(a.supervisor_id) || t("Unnamed")),
      ),
    ];
  }, [member, departmentId, supervisorsQ.data, t]);

  // Where they work. A clock-in is filed under one of these, so their hours
  // can be split by location on the timecard.
  const locationsQ = useQuery({
    queryKey: ["locations", companyId, "names"],
    enabled: !!member,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("locations").select("id, name").eq("company_id", companyId).order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const visibilityQ = useQuery({
    queryKey: ["member-visibility-one", member?.id],
    enabled: !!member,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("member_visibility")
        .select("mode")
        .eq("user_id", member!.id)
        .eq("company_id", companyId)
        .maybeSingle();
      if (error) throw error;
      return (data?.mode ?? "") as VisibilityMode | "";
    },
  });

  useEffect(() => {
    if (visibilityQ.data !== undefined) setVisibility(visibilityQ.data);
  }, [visibilityQ.data]);

  const worksAtQ = useQuery({
    queryKey: ["employee-locations", member?.id, companyId],
    enabled: !!member,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employee_locations")
        .select("location_id")
        .eq("employee_id", member!.id)
        .eq("company_id", companyId);
      if (error) throw error;
      return (data ?? []).map((r) => r.location_id);
    },
  });

  const profileQ = useQuery({
    queryKey: ["member-profile", member?.id],
    enabled: !!member,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("company_members")
        .select("max_weekly_hours, is_active, department_id, position_id")
        .eq("id", member!.id)
        .eq("company_id", companyId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return data;
      // Missing until the organization structure migration runs.
      const loc = await supabase
        .from("company_members")
        .select("location_id")
        .eq("id", member!.id)
        .eq("company_id", companyId)
        .maybeSingle();
      return { ...data, location_id: loc.error ? null : (loc.data?.location_id ?? null) };
    },
  });

  useEffect(() => {
    if (member) {
      setFullName(member.full_name);
      setLegacyTitle(member.position ?? "");
      setErr(null);
    }
  }, [member]);

  useEffect(() => {
    if (profileQ.data) {
      setMaxHours(Number(profileQ.data.max_weekly_hours ?? 40));
      setIsActive(profileQ.data.is_active ?? true);
      setDepartmentId(profileQ.data.department_id ?? "");
      setPositionId(profileQ.data.position_id ?? "");
      setLocationId(profileQ.data.location_id ?? "");
    }
  }, [profileQ.data]);

  const positionName = (id: string) => org.positions.find((p) => p.id === id)?.name ?? "";
  const departmentName = (id: string) => org.departments.find((d) => d.id === id)?.name ?? "";
  // A department change that leaves their position behind: a new one has to
  // be picked before saving.
  const mustRepick =
    !positionId &&
    !!profileQ.data?.position_id &&
    !positionFitsDepartment(profileQ.data.position_id, departmentId, org.links);
  const positionFits =
    !mustRepick && positionFitsDepartment(positionId, departmentId, org.links);
  const locationOptions = activeOrCurrent(org.locations, profileQ.data?.location_id);
  const departmentOptions = activeOrCurrent(org.departments, profileQ.data?.department_id);
  const positionOptions = positionsForDepartment(
    departmentId,
    org.positions,
    org.links,
    profileQ.data?.position_id,
  );
  const inactive = (item: { is_active: boolean }) => (item.is_active ? "" : ` (${t("inactive")})`);

  useEffect(() => {
    if (worksAtQ.data) setWorksAt(new Set(worksAtQ.data));
  }, [worksAtQ.data]);

  function toggleWorksAt(id: string) {
    setWorksAt((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function save() {
    if (!member) return;
    if (!positionFits) {
      setErr(t("Pick a position that is part of {department}.", { department: departmentName(departmentId) }));
      return;
    }
    // Stops at the first Edit member field; bulk edit has its own.
    setSaving(true);
    setErr(null);

    const hadPosition = !!profileQ.data?.position_id;
    const { error } = await supabase
      .from("company_members")
      .update({
        full_name: fullName.trim(),
        position_id: positionId || null,
        // The shown job title is the position's name. A typed title with no
        // position is left alone until a position is picked.
        ...(positionId ? { position: positionName(positionId) } : hadPosition ? { position: null } : {}),
        department_id: departmentId || null,
        ...(org.missing ? {} : { location_id: locationId || null }),
        max_weekly_hours: maxHours,
        is_active: isActive,
      })
      .eq("id", member.id)
      .eq("company_id", companyId);
    if (error) { setSaving(false); setErr(error.message); return; }

    // Reconcile locations against what was loaded, so we only write deltas.
    const wasAt = new Set(worksAtQ.data ?? []);
    const locAdd = [...worksAt].filter((id) => !wasAt.has(id));
    const locRemove = [...wasAt].filter((id) => !worksAt.has(id));
    if (locAdd.length) {
      // Upsert, skipping rows that already exist: a location can already be
      // on file (loaded late, or saved twice), and that is not an error.
      const { error: addErr } = await supabase.from("employee_locations").upsert(
        locAdd.map((location_id) => ({ company_id: companyId, employee_id: member.id, location_id })),
        { onConflict: "employee_id,location_id", ignoreDuplicates: true },
      );
      if (addErr) { setSaving(false); setErr(addErr.message); return; }
    }
    if (locRemove.length) {
      const { error: rmErr } = await supabase
        .from("employee_locations").delete()
        .eq("company_id", companyId)
        .eq("employee_id", member.id).in("location_id", locRemove);
      if (rmErr) { setSaving(false); setErr(rmErr.message); return; }
    }

    // Where they show up: a row for a choice, none for the company default.
    if (visibilityQ.isSuccess && visibility !== visibilityQ.data) {
      const { error: visErr } = visibility
        ? await supabase.from("member_visibility").upsert({
            user_id: member.id,
            company_id: companyId,
            mode: visibility,
            updated_at: new Date().toISOString(),
          })
        : await supabase
            .from("member_visibility")
            .delete()
            .eq("user_id", member.id)
            .eq("company_id", companyId);
      if (visErr) { setSaving(false); setErr(visErr.message); return; }
      void qc.invalidateQueries({ queryKey: ["member-visibility"] });
      void qc.invalidateQueries({ queryKey: ["member-visibility-one", member.id] });
    }

    setSaving(false);
    void qc.invalidateQueries({ queryKey: ["member-profile", member.id] });
    void qc.invalidateQueries({ queryKey: ["employee-locations", member.id] });
    void qc.invalidateQueries({ queryKey: ["position-pay-rules"] });
    void qc.invalidateQueries({ queryKey: [ORG_STRUCTURE_KEY] });
    onSaved();
  }

  return (
    <Dialog open={!!member} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Edit member")}</DialogTitle>
          <DialogDescription>
            {t("Name, scheduling limits and work locations. Roles are managed from the roster.")}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          <div>
            <Label htmlFor="full-name">{t("Full name")}</Label>
            <Input id="full-name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} />
          </div>
          {!org.missing && (
            <div>
              <Label htmlFor="work-location">{t("Work location")}</Label>
              <select
                id="work-location"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
                value={locationId}
                onChange={(e) => {
                  const id = e.target.value;
                  setLocationId(id);
                  if (id) setWorksAt((prev) => new Set(prev).add(id));
                }}
              >
                <option value="">{t("— no work location —")}</option>
                {locationOptions.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {inactive(l)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {locationOptions.length === 0
                  ? t("No locations yet — add them under Settings → Organization → Locations.")
                  : t("Where they mainly work.")}
              </p>
            </div>
          )}

          <div>
            <Label htmlFor="department">{t("Department")}</Label>
            <select
              id="department"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
              value={departmentId}
              onChange={(e) => {
                const id = e.target.value;
                setDepartmentId(id);
                // A position that isn't part of the new department has to be picked again.
                if (!positionFitsDepartment(positionId, id, org.links)) setPositionId("");
              }}
            >
              <option value="">{t("— no department —")}</option>
              {departmentOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {inactive(d)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              {departmentOptions.length === 0
                ? t("No departments yet — add them under Settings → Organization → Departments.")
                : supervisorNames.length
                  ? t("Supervisor: {names}", { names: supervisorNames.join(", ") })
                  : departmentId
                    ? t("No supervisor for this department.")
                    : t("The schedule builder can divide its rows by department.")}
            </p>
          </div>

          <div>
            <Label htmlFor="position">{t("Position")}</Label>
            <select
              id="position"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
              value={positionId}
              onChange={(e) => setPositionId(e.target.value)}
            >
              <option value="">{t("— no position —")}</option>
              {positionOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {inactive(p)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              {!positionId && legacyTitle && !profileQ.data?.position_id
                ? t("Was typed as “{title}”. Pick the position it should be.", { title: legacyTitle })
                : mustRepick && profileQ.data?.position_id
                  ? t("“{title}” isn't part of {department}. Pick a position from the department.", {
                      title: positionName(profileQ.data.position_id),
                      department: departmentName(departmentId),
                    })
                  : org.positions.length === 0
                    ? t("No positions yet — add them under Settings → Organization → Positions.")
                    : departmentId
                      ? t("Positions in {department}.", { department: departmentName(departmentId) })
                      : t("Pick a department first to see only its positions.")}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="max-hours">{t("Max weekly hours")}</Label>
              <Input
                id="max-hours"
                type="number"
                min={1}
                max={168}
                value={maxHours}
                onChange={(e) => setMaxHours(Number(e.target.value))}
              />
            </div>
            <div>
              <Label htmlFor="active">{t("Status")}</Label>
              <select
                id="active"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
                value={isActive ? "active" : "inactive"}
                onChange={(e) => setIsActive(e.target.value === "active")}
              >
                <option value="active">{t("Active")}</option>
                <option value="inactive">{t("Inactive")}</option>
              </select>
            </div>
          </div>

          <div>
            <Label htmlFor="visibility">{t("Shows up on")}</Label>
            <select
              id="visibility"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
              value={visibility}
              disabled={visibilityQ.isLoading || visibilityQ.isError}
              onChange={(e) => setVisibility(e.target.value as VisibilityMode | "")}
            >
              <option value="">{t("Company default")}</option>
              <option value="everywhere">{t("Schedule and timecards")}</option>
              <option value="schedule_only">{t("Schedule only")}</option>
              <option value="timecards_only">{t("Timecards only")}</option>
              <option value="ghost">{t("Nowhere (ghost)")}</option>
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              {visibilityQ.isError
                ? t("Run the member visibility update in Supabase to use this.")
                : visibility === "ghost"
                  ? t("Kept off the schedule, the timecards and the dashboard. They can still open their own timecard.")
                  : visibility === "schedule_only"
                    ? t("On the schedule, but not on the timecard list.")
                    : visibility === "timecards_only"
                      ? t("On the timecard list, but not on the schedule.")
                      : visibility === "everywhere"
                        ? t("On the schedule and the timecards, even if they are an admin.")
                        : t("Employees show everywhere. Admins follow “Hide admins from the rosters” in App rules.")}
            </p>
          </div>

          <div>
            <Label>{t("Clock-in locations")}</Label>
            {(locationsQ.data ?? []).length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("No locations yet — add them under Settings → Organization → Locations.")}
              </p>
            ) : (
              <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                {(locationsQ.data ?? [])
                  .filter((l) => worksAt.has(l.id) || (org.locations.find((o) => o.id === l.id)?.is_active ?? true))
                  .map((l) => (
                  <label
                    key={l.id}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-sm hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      checked={worksAt.has(l.id)}
                      onChange={() => toggleWorksAt(l.id)}
                      className="h-4 w-4"
                    />
                    <span className="truncate text-foreground">{l.name}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("Where they may clock in. Their hours on the timecard are split by the location each shift was worked at.")}
            </p>
          </div>

          {member && <TempPasswordSection key={member.id} userId={member.id} name={member.full_name} />}

          {err && <p className="text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("Cancel")}
          </Button>
          <Button onClick={save} disabled={saving || !fullName.trim() || !positionFits}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The same settings for several people at once. Every field starts at "Leave
 * as is", and only the fields someone changes are written — ticking ten people
 * to move them to one team must not also reset their hours or their locations.
 */
function BulkEditDialog({
  open,
  members,
  companyId,
  onClose,
  onSaved,
}: {
  open: boolean;
  members: MemberRow[];
  companyId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT("people");
  const KEEP = "__keep__";
  const [positionId, setPositionId] = useState(KEEP);
  const [departmentId, setDepartmentId] = useState(KEEP);
  const [locationId, setLocationId] = useState(KEEP);
  const org = useOrgStructure(companyId, open);
  const [maxHours, setMaxHours] = useState("");
  const [status, setStatus] = useState(KEEP);
  const [visibility, setVisibility] = useState(KEEP);
  const [replaceLocations, setReplaceLocations] = useState(false);
  const [worksAt, setWorksAt] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // A fresh form each time it opens.
  useEffect(() => {
    if (!open) return;
    setPositionId(KEEP);
    setDepartmentId(KEEP);
    setLocationId(KEEP);
    setMaxHours("");
    setStatus(KEEP);
    setVisibility(KEEP);
    setReplaceLocations(false);
    setWorksAt(new Set());
    setErr(null);
  }, [open]);

  const locationsQ = useQuery({
    queryKey: ["locations", companyId, "names"],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("locations").select("id, name").eq("company_id", companyId).order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const hours = maxHours.trim() === "" ? null : Number(maxHours);
  const hoursBad = hours != null && (!Number.isFinite(hours) || hours < 1 || hours > 168);
  // Who would end up in a department their position isn't part of.
  const misfits = members.filter((m) => {
    const dept = departmentId === KEEP ? m.department_id : departmentId || null;
    const pos = positionId === KEEP ? m.position_id : positionId || null;
    return !positionFitsDepartment(pos, dept, org.links);
  });
  const departmentName = (id: string) => org.departments.find((d) => d.id === id)?.name ?? "";
  const positionName = (id: string) => org.positions.find((p) => p.id === id)?.name ?? "";
  const positionOptions =
    departmentId !== KEEP && departmentId
      ? positionsForDepartment(departmentId, org.positions, org.links)
      : activeOrCurrent(org.positions);
  const nothingChanged =
    positionId === KEEP &&
    locationId === KEEP &&
    departmentId === KEEP &&
    hours == null &&
    status === KEEP &&
    visibility === KEEP &&
    !replaceLocations;

  async function save() {
    const ids = members.map((m) => m.id);
    if (ids.length === 0) return;
    if (misfits.length) return;
    setSaving(true);
    setErr(null);
    try {
      const patch: {
        position?: string | null;
        position_id?: string | null;
        department_id?: string | null;
        location_id?: string | null;
        max_weekly_hours?: number;
        is_active?: boolean;
      } = {};
      if (positionId !== KEEP) {
        patch.position_id = positionId || null;
        patch.position = positionId ? positionName(positionId) : null;
      }
      if (departmentId !== KEEP) patch.department_id = departmentId || null;
      if (locationId !== KEEP && !org.missing) patch.location_id = locationId || null;
      if (hours != null) patch.max_weekly_hours = hours;
      if (status !== KEEP) patch.is_active = status === "active";
      if (Object.keys(patch).length > 0) {
        const { error } = await supabase
          .from("company_members")
          .update(patch)
          .in("id", ids)
          .eq("company_id", companyId);
        if (error) throw error;
      }

      if (visibility !== KEEP) {
        const { error } = visibility
          ? await supabase.from("member_visibility").upsert(
              ids.map((user_id) => ({
                user_id,
                company_id: companyId,
                mode: visibility,
                updated_at: new Date().toISOString(),
              })),
            )
          : await supabase
              .from("member_visibility")
              .delete()
              .in("user_id", ids)
              .eq("company_id", companyId);
        if (error) throw error;
      }

      if (replaceLocations) {
        const { error: rmErr } = await supabase
          .from("employee_locations").delete().in("employee_id", ids).eq("company_id", companyId);
        if (rmErr) throw rmErr;
        const rows = ids.flatMap((employee_id) =>
          [...worksAt].map((location_id) => ({ company_id: companyId, employee_id, location_id })),
        );
        if (rows.length) {
          const { error: addErr } = await supabase
            .from("employee_locations")
            .upsert(rows, { onConflict: "employee_id,location_id", ignoreDuplicates: true });
          if (addErr) throw addErr;
        }
      }

      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const selectClass =
    "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {members.length === 1
              ? t("Edit 1 person")
              : t("Edit {n} people", { n: members.length })}
          </DialogTitle>
          <DialogDescription>
            {t("Only what you change is saved, and it is saved for everyone picked. Anything left as is stays as it was for each person.")}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          <p className="text-xs text-muted-foreground">
            {members.map((m) => m.full_name || t("Unnamed")).join(", ")}
          </p>

          {!org.missing && (
            <div>
              <Label htmlFor="bulk-location">{t("Work location")}</Label>
              <select
                id="bulk-location"
                className={selectClass}
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                <option value={KEEP}>{t("— leave as is —")}</option>
                <option value="">{t("— no work location —")}</option>
                {activeOrCurrent(org.locations).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <Label htmlFor="bulk-department">{t("Department")}</Label>
            <select
              id="bulk-department"
              className={selectClass}
              value={departmentId}
              onChange={(e) => {
                const id = e.target.value;
                setDepartmentId(id);
                if (positionId !== KEEP && !positionFitsDepartment(positionId || null, id === KEEP ? null : id || null, org.links))
                  setPositionId(KEEP);
              }}
            >
              <option value={KEEP}>{t("— leave as is —")}</option>
              <option value="">{t("— no department —")}</option>
              {activeOrCurrent(org.departments).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="bulk-position">{t("Position")}</Label>
            <select
              id="bulk-position"
              className={selectClass}
              value={positionId}
              onChange={(e) => setPositionId(e.target.value)}
            >
              <option value={KEEP}>{t("— leave as is —")}</option>
              <option value="">{t("— no position —")}</option>
              {positionOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {misfits.length > 0 && (
              <p className="mt-1 text-xs text-destructive">
                {departmentId !== KEEP && departmentId
                  ? t("Pick a position from {department} — these people's positions aren't part of it: {names}", {
                      department: departmentName(departmentId),
                      names: misfits.map((m) => m.full_name || t("Unnamed")).join(", "),
                    })
                  : t("That position isn't part of the department of: {names}", {
                      names: misfits.map((m) => m.full_name || t("Unnamed")).join(", "),
                    })}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="bulk-hours">{t("Max weekly hours")}</Label>
              <Input
                id="bulk-hours"
                type="number"
                min={1}
                max={168}
                value={maxHours}
                onChange={(e) => setMaxHours(e.target.value)}
                placeholder={t("Leave as is")}
              />
            </div>
            <div>
              <Label htmlFor="bulk-status">{t("Status")}</Label>
              <select
                id="bulk-status"
                className={selectClass}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value={KEEP}>{t("— leave as is —")}</option>
                <option value="active">{t("Active")}</option>
                <option value="inactive">{t("Inactive")}</option>
              </select>
            </div>
          </div>

          <div>
            <Label htmlFor="bulk-visibility">{t("Shows up on")}</Label>
            <select
              id="bulk-visibility"
              className={selectClass}
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
            >
              <option value={KEEP}>{t("— leave as is —")}</option>
              <option value="">{t("Company default")}</option>
              <option value="everywhere">{t("Schedule and timecards")}</option>
              <option value="schedule_only">{t("Schedule only")}</option>
              <option value="timecards_only">{t("Timecards only")}</option>
              <option value="ghost">{t("Nowhere (ghost)")}</option>
            </select>
          </div>

          <div>
            <Label>{t("Clock-in locations")}</Label>
            <label className="mt-1 flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={replaceLocations}
                onChange={(e) => setReplaceLocations(e.target.checked)}
              />
              {t("Replace their clock-in locations with:")}
            </label>
            {(locationsQ.data ?? []).length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("No locations yet — add them under Settings → Organization → Locations.")}
              </p>
            ) : (
              <div
                className={`mt-1.5 grid gap-1.5 sm:grid-cols-2 ${replaceLocations ? "" : "opacity-50"}`}
              >
                {(locationsQ.data ?? []).map((l) => (
                  <label
                    key={l.id}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-sm hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      disabled={!replaceLocations}
                      checked={worksAt.has(l.id)}
                      onChange={() =>
                        setWorksAt((prev) => {
                          const next = new Set(prev);
                          if (next.has(l.id)) next.delete(l.id); else next.add(l.id);
                          return next;
                        })
                      }
                    />
                    <span className="truncate text-foreground">{l.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {err && <p className="text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("Cancel")}
          </Button>
          <Button onClick={save} disabled={saving || nothingChanged || hoursBad || misfits.length > 0}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {members.length === 1
              ? t("Save for 1 person")
              : t("Save for {n} people", { n: members.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SuspendedRow {
  id: string;
  full_name: string;
  reason: string | null;
  since: string;
}

function SuspendedMembersCard({
  rows,
  onReinstate,
  pendingId,
}: {
  rows: SuspendedRow[];
  onReinstate: (userId: string) => void;
  pendingId: string | null;
}) {
  const t = useT("people");
  if (rows.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border p-4">
        <PauseCircle className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">{t("Suspended")}</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {rows.length}
        </span>
      </div>
      <div className="divide-y divide-border">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{r.full_name || t("Unnamed")}</p>
              <p className="truncate text-xs text-muted-foreground">
                {t("No access since {date}", { date: new Date(r.since).toLocaleDateString() })}
                {r.reason ? ` · ${r.reason}` : ""}
              </p>
            </div>
            <Button size="sm" variant="outline" disabled={pendingId === r.id} onClick={() => onReinstate(r.id)}>
              {pendingId === r.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="mr-1.5 h-3.5 w-3.5" />}
              {t("Reinstate")}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function JoinRequestsCard({
  requests,
  loading,
  approving,
  rejecting,
}: {
  requests: MemberRow[];
  loading: boolean;
  approving: { mutate: (id: string) => void; isPending: boolean; variables?: string };
  rejecting: { mutate: (id: string) => void; isPending: boolean; variables?: string };
}) {
  const t = useT("people");
  if (loading || requests.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="flex items-center gap-2">
          <UserCog className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">{t("Pending join requests")}</h3>
          <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary">
            {requests.length}
          </span>
        </div>
      </div>
      <div className="divide-y divide-border">
        {requests.map((r) => {
          const initials = r.full_name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase() || "?";
          const approveBusy = approving.isPending && approving.variables === r.id;
          const rejectBusy = rejecting.isPending && rejecting.variables === r.id;
          const busy = approveBusy || rejectBusy;
          return (
            <div key={r.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary">
                  {initials}
                </div>
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{r.full_name || t("Unnamed")}</p>
                  <p className="truncate text-xs text-muted-foreground">{r.position || t("Requested to join")}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => approving.mutate(r.id)} disabled={busy}>
                  {approveBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                  {t("Approve")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => rejecting.mutate(r.id)}
                  disabled={busy}
                >
                  {rejectBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
