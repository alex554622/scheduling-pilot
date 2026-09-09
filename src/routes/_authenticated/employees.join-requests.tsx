import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Loader2, UserCheck, UserX, ArrowLeft, Inbox } from "lucide-react";

export const Route = createFileRoute("/_authenticated/employees/join-requests")({
  component: JoinRequestsPage,
});

interface JoinRequest {
  id: string;
  full_name: string | null;
  position: string | null;
}

function JoinRequestsPage() {
  const { primaryRole, profile, company, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companyId = profile?.company_id ?? null;

  useEffect(() => {
    if (!loading && primaryRole !== "company_admin" && primaryRole !== "super_admin") {
      navigate({ to: "/dashboard" });
    }
  }, [loading, primaryRole, navigate]);

  const requestsQ = useQuery({
    queryKey: ["company-join-requests", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, position")
        .eq("pending_company_id", companyId!)
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as JoinRequest[];
    },
  });

  const approveMut = useMutation({
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

  const rejectMut = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("reject_membership", { _user: userId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["company-join-requests", companyId] }),
  });

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const requests = requestsQ.data ?? [];
  const pendingId = approveMut.isPending ? approveMut.variables : rejectMut.isPending ? rejectMut.variables : null;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link to="/employees" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to employees
          </Link>
          <h2 className="text-2xl font-semibold text-foreground">Join requests</h2>
          <p className="text-sm text-muted-foreground">
            People who signed up with {company?.name ?? "your company"}'s join code{company?.join_code ? ` (${company.join_code})` : ""}. Approve to add them as employees.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card shadow-[var(--shadow-card)]">
        <div className="border-b border-border px-5 py-4 flex items-center gap-2">
          <Inbox className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-foreground">
            Pending ({requestsQ.isLoading ? "…" : requests.length})
          </h3>
        </div>

        {requestsQ.isLoading ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : requests.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <Inbox className="mx-auto h-8 w-8 text-muted-foreground/60" />
            <p className="mt-3 text-sm text-muted-foreground">No pending join requests.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {requests.map((r) => {
              const busy = pendingId === r.id;
              const initials = (r.full_name ?? "?").split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
              return (
                <li key={r.id} className="flex items-center gap-3 px-5 py-4">
                  <div className="grid h-9 w-9 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary">
                    {initials || "?"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{r.full_name || "Unnamed user"}</p>
                    {r.position && <p className="truncate text-xs text-muted-foreground">{r.position}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => rejectMut.mutate(r.id)}
                    >
                      {busy && rejectMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserX className="h-4 w-4" />}
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => approveMut.mutate(r.id)}
                    >
                      {busy && approveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCheck className="h-4 w-4" />}
                      Approve
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {(approveMut.error || rejectMut.error) && (
          <p className="border-t border-border px-5 py-3 text-sm text-destructive">
            {(approveMut.error as Error | null)?.message ?? (rejectMut.error as Error | null)?.message}
          </p>
        )}
      </div>
    </div>
  );
}
