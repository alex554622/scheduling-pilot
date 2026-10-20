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
import { Users, ShieldCheck, Search, Copy, Check, Loader2, UserCog, Trash2, Pencil, Mail, Send, X, Link2, RefreshCw, CalendarClock, Inbox, History, RotateCcw } from "lucide-react";
import { shareableOrigin } from "@/lib/native/platform";

export const Route = createFileRoute("/_authenticated/employees")({
  component: EmployeesPage,
});

type AssignableRole = Exclude<AppRole, "super_admin">;
const ASSIGNABLE_ROLES: AssignableRole[] = ["company_admin", "employee"];

interface MemberRow {
  id: string;
  full_name: string;
  position: string | null;
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
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removing, setRemoving] = useState<MemberRow | null>(null);

  const membersQ = useQuery({
    queryKey: ["company-members", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, position")
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

  const setRoleMut = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: AssignableRole }) => {
      // Replace any existing assignable roles for this user in this company with the chosen one.
      const { error: delErr } = await supabase
        .from("user_roles")
        .delete()
        .eq("user_id", userId)
        .eq("company_id", companyId)
        .in("role", ASSIGNABLE_ROLES);
      if (delErr) throw delErr;
      const { error: insErr } = await supabase
        .from("user_roles")
        .insert({ user_id: userId, company_id: companyId, role });
      if (insErr) throw insErr;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["company-roles", companyId] }),
  });

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
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, position")
        .eq("pending_company_id", companyId)
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as MemberRow[];
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
    const c = { company_admin: 0, employee: 0, none: 0 };
    (membersQ.data ?? []).forEach((m) => {
      const rs = rolesByUser.get(m.id) ?? [];
      if (rs.includes("company_admin")) c.company_admin++;
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



      <div className="grid gap-3 md:grid-cols-3">
        <StatCard label={t("Total members")} value={(membersQ.data ?? []).length} icon={Users} />
        <StatCard label={t("Admins")} value={counts.company_admin} icon={ShieldCheck} />
        <StatCard label={t("Employees")} value={counts.employee} icon={Users} />
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border p-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("Search by name or position…")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 border-0 shadow-none focus-visible:ring-0"
          />
        </div>

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
                (removeMut.isPending && removeMut.variables?.userId === m.id);
              return (
                <div key={m.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid h-10 w-10 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary">
                      {initials}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{m.full_name || t("Unnamed")}</p>
                      <p className="truncate text-xs text-muted-foreground">{m.position || t("No position set")}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={current}
                      disabled={busy}
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
                    <Button variant="outline" size="sm" onClick={() => setEditing(m)} disabled={busy}>
                      <Pencil className="mr-1.5 h-3.5 w-3.5" /> {t("Edit")}
                    </Button>
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

      {(setRoleMut.error || removeMut.error || rehireMut.error) && (
        <p className="text-sm text-destructive">
          {(setRoleMut.error as Error)?.message ||
            (removeMut.error as Error)?.message ||
            (rehireMut.error as Error)?.message}
        </p>
      )}

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

      <EditMemberDialog
        member={editing}
        companyId={companyId}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          qc.invalidateQueries({ queryKey: ["company-members", companyId] });
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
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(ROLE_LABEL[r])}
                  </option>
                ))}
              </select>
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
  const [position, setPosition] = useState("");
  // Which team they are on. Teams are the company's departments, and the
  // schedule builder can divide its rows by them.
  const [departmentId, setDepartmentId] = useState("");
  const [maxHours, setMaxHours] = useState<number>(40);
  const [isActive, setIsActive] = useState(true);
  const [worksAt, setWorksAt] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const departmentsQ = useQuery({
    queryKey: ["departments", companyId],
    enabled: !!member,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("departments")
        .select("id, name")
        .eq("company_id", companyId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });

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

  const worksAtQ = useQuery({
    queryKey: ["employee-locations", member?.id],
    enabled: !!member,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employee_locations").select("location_id").eq("employee_id", member!.id);
      if (error) throw error;
      return (data ?? []).map((r) => r.location_id);
    },
  });

  const profileQ = useQuery({
    queryKey: ["member-profile", member?.id],
    enabled: !!member,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("max_weekly_hours, is_active, department_id")
        .eq("id", member!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (member) {
      setFullName(member.full_name);
      setPosition(member.position ?? "");
      setErr(null);
    }
  }, [member]);

  useEffect(() => {
    if (profileQ.data) {
      setMaxHours(Number(profileQ.data.max_weekly_hours ?? 40));
      setIsActive(profileQ.data.is_active ?? true);
      setDepartmentId(profileQ.data.department_id ?? "");
    }
  }, [profileQ.data]);

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
    setSaving(true);
    setErr(null);

    const { error } = await supabase
      .from("profiles")
      .update({
        full_name: fullName.trim(),
        position: position.trim() || null,
        department_id: departmentId || null,
        max_weekly_hours: maxHours,
        is_active: isActive,
      })
      .eq("id", member.id);
    if (error) { setSaving(false); setErr(error.message); return; }

    // Reconcile locations against what was loaded, so we only write deltas.
    const wasAt = new Set(worksAtQ.data ?? []);
    const locAdd = [...worksAt].filter((id) => !wasAt.has(id));
    const locRemove = [...wasAt].filter((id) => !worksAt.has(id));
    if (locAdd.length) {
      const { error: addErr } = await supabase.from("employee_locations").insert(
        locAdd.map((location_id) => ({ company_id: companyId, employee_id: member.id, location_id })),
      );
      if (addErr) { setSaving(false); setErr(addErr.message); return; }
    }
    if (locRemove.length) {
      const { error: rmErr } = await supabase
        .from("employee_locations").delete()
        .eq("employee_id", member.id).in("location_id", locRemove);
      if (rmErr) { setSaving(false); setErr(rmErr.message); return; }
    }

    setSaving(false);
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
          <div>
            <Label htmlFor="position">{t("Job title")}</Label>
            <Input
              id="position"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              placeholder={t("e.g. Barista, Shift Lead")}
              maxLength={120}
            />
          </div>

          <div>
            <Label htmlFor="team">{t("Team")}</Label>
            <select
              id="team"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
            >
              <option value="">{t("— no team —")}</option>
              {(departmentsQ.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              {(departmentsQ.data ?? []).length === 0
                ? t("No teams yet — add them on Organization → Departments.")
                : t("The schedule builder can divide its rows under each team.")}
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
            <Label>{t("Work locations")}</Label>
            {(locationsQ.data ?? []).length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("No locations yet — add them under Organization → Locations.")}
              </p>
            ) : (
              <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                {(locationsQ.data ?? []).map((l) => (
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
              {t("Their hours on the timecard are split by the location each shift was worked at.")}
            </p>
          </div>

          {err && <p className="text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("Cancel")}
          </Button>
          <Button onClick={save} disabled={saving || !fullName.trim()}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
