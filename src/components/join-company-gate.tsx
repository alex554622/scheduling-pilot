import { useEffect, useState } from "react";
import { Loader2, Building2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { takeSignupIntentError } from "@/lib/signup-intent";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandLogo } from "@/components/brand";

const CODE_PATTERN = /^[A-Za-z0-9]{6,12}$/;

/**
 * What a signed-in account with no company sees. That happens when someone signs
 * up as an employee without a code, or when the code they gave at signup was
 * rejected — either way this is the one screen they can reach, so it has to be
 * the place they can attach a company.
 */
export function JoinCompanyGate({ onSignOut }: { onSignOut: () => void }) {
  const { user, profile, refresh } = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A code entered at signup is applied later, during an auth load, so a
  // rejection has no form to land on. It waits here instead.
  useEffect(() => {
    const parked = takeSignupIntentError();
    if (parked) setError(`The company code from your signup wasn't accepted: ${parked}`);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (!CODE_PATTERN.test(trimmed)) {
      setError("Enter the 8-character company code from your admin (letters and digits).");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("join_company_by_code", { _code: trimmed });
    if (rpcError) {
      setBusy(false);
      setError(rpcError.message);
      return;
    }
    // Success flips `pending_company_id`, which swaps this screen for the
    // "awaiting approval" one.
    await refresh();
    setBusy(false);
  }

  return (
    <div className="grid min-h-screen place-items-center bg-secondary/30 px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-[var(--shadow-card)]">
        <div className="mb-6 flex justify-center">
          <BrandLogo className="h-14" />
        </div>

        <div className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-semibold text-foreground">Add your company</h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Your profile is ready{profile?.full_name ? `, ${profile.full_name.split(" ")[0]}` : ""}. Enter the join code from
          your manager to request access to their workspace.
        </p>

        <form className="mt-5 space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="join-code">Company code</Label>
            <Input
              id="join-code"
              autoFocus
              required
              maxLength={12}
              placeholder="e.g. A1B2C3D4"
              className="h-12 text-center text-lg uppercase tracking-[0.3em]"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <p className="text-xs text-muted-foreground">
              A company admin approves the request before you get access.
            </p>
          </div>

          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

          <Button type="submit" className="h-11 w-full" disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Request to join
          </Button>
        </form>

        <div className="mt-6 border-t border-border pt-4 text-center">
          <p className="text-xs text-muted-foreground">Signed in as {user?.email}</p>
          <button onClick={onSignOut} className="mt-2 text-sm font-medium text-primary hover:underline">
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
