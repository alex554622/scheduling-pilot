import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, roleLabel } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { BrandLogo } from "@/components/brand";

const searchSchema = z.object({
  token: z.string().uuid().optional(),
});

export const Route = createFileRoute("/join")({
  validateSearch: (s) => searchSchema.parse(s),
  component: JoinPage,
});

interface InvitePreview {
  id: string;
  company_id: string;
  company_name: string;
  email: string;
  /** Straight from the DB enum, so it can still read "supervisor" on an invite
   *  issued before that role was folded into company_admin. */
  role: string;
  status: string;
  expires_at: string;
}


function JoinPage() {
  const { token } = Route.useSearch();
  const { user, loading: authLoading, refresh } = useAuth();
  const navigate = useNavigate();

  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("This invite link is missing its token.");
      setLoading(false);
      return;
    }
    (async () => {
      const { data, error } = await supabase.rpc("get_invitation_by_token", { _token: token });
      if (error) {
        setError(error.message);
      } else if (!data || data.length === 0) {
        setError("Invitation not found.");
      } else {
        setInvite(data[0] as InvitePreview);
      }
      setLoading(false);
    })();
  }, [token]);

  async function accept() {
    if (!token) return;
    setAccepting(true);
    setError(null);
    const { error } = await supabase.rpc("accept_invitation", { _token: token });
    setAccepting(false);
    if (error) {
      setError(error.message);
      return;
    }
    await refresh();
    setDone(true);
    setTimeout(() => navigate({ to: "/dashboard" }), 1200);
  }

  const expired = invite && new Date(invite.expires_at) < new Date();
  const wrongEmail =
    invite && user?.email && invite.email.toLowerCase() !== user.email.toLowerCase();

  return (
    <div className="grid min-h-screen place-items-center bg-secondary/30 px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-5">
          <BrandLogo className="h-16" />
        </div>

        {loading || authLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking invitation…
          </div>
        ) : error ? (
          <ErrorBlock message={error} />
        ) : invite ? (
          <>
            <h1 className="text-xl font-semibold text-foreground">You're invited</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{invite.company_name}</span> invited{" "}
              <span className="font-medium text-foreground">{invite.email}</span> to join as{" "}
              <span className="font-medium text-foreground">{roleLabel(invite.role)}</span>.
            </p>

            {invite.status !== "pending" ? (
              <ErrorBlock message={`This invitation is ${invite.status}.`} />
            ) : expired ? (
              <ErrorBlock message="This invitation has expired. Ask an admin to send a new one." />
            ) : done ? (
              <div className="mt-5 flex items-center gap-2 rounded-lg bg-primary-soft p-3 text-sm text-primary">
                <CheckCircle2 className="h-4 w-4" /> Joined! Redirecting…
              </div>
            ) : !user ? (
              <div className="mt-5 space-y-2">
                <p className="text-sm text-muted-foreground">
                  Sign in or create an account with <strong>{invite.email}</strong> to accept.
                </p>
                <Link
                  to="/login"
                  search={{ invite: token } as never}
                  className="block w-full rounded-md bg-primary px-4 py-2 text-center text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  Continue to sign in
                </Link>
              </div>
            ) : wrongEmail ? (
              <ErrorBlock
                message={`You're signed in as ${user.email}, but this invite is for ${invite.email}. Sign out and use the invited email.`}
              />
            ) : (
              <Button className="mt-5 w-full" onClick={accept} disabled={accepting}>
                {accepting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Accept invitation
              </Button>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="mt-5 flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
      <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <span>{message}</span>
    </div>
  );
}
