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
 * up as an employee without a code, when the code they gave at signup was
 * rejected — or when a business registration never completed.
 *
 * That last one is why this screen offers both. The company a registration asks
 * for is created by replaying the signup intent, which is held in the browser
 * that made it (see `@/lib/signup-intent`). Confirm the email somewhere else —
 * and a confirmation link very often opens the phone's default browser, not the
 * one the form was filled in on — and the intent is simply not there to replay.
 * The account arrives here instead, and until now the only thing on offer was a
 * join code for a company that had never been created. The registration was
 * lost, and the platform admin's approval queue never heard about it.
 */
export function JoinCompanyGate({ onSignOut }: { onSignOut: () => void }) {
  const { user, profile, refresh, roles } = useAuth();
  /**
   * Which half of this screen someone lands on.
   *
   * An account that already holds a company admin role was meant to be running
   * a company — either the registration half-finished, or the company it made
   * was removed. Sending that person to a join-code box is sending them to the
   * wrong screen, so they are asked for the company name instead.
   */
  const wasRegistering = roles.includes("company_admin") || roles.includes("super_admin");
  const [mode, setMode] = useState<"join" | "create">(wasRegistering ? "create" : "join");
  const [code, setCode] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A code entered at signup is applied later, during an auth load, so a
  // rejection has no form to land on. It waits here instead.
  useEffect(() => {
    const parked = takeSignupIntentError();
    if (parked) setError(`The company code from your signup wasn't accepted: ${parked}`);
  }, []);

  async function registerBusiness(e: React.FormEvent) {
    e.preventDefault();
    const name = companyName.trim();
    if (name.length < 2) {
      setError("Enter the name of your business.");
      return;
    }
    setBusy(true);
    setError(null);
    // The same RPC the signup would have run. It lands the company at
    // 'pending', which is what puts it in front of a platform admin.
    const { error: rpcError } = await supabase.rpc("bootstrap_company", { _name: name });
    if (rpcError) {
      setBusy(false);
      setError(rpcError.message);
      return;
    }
    await refresh();
    setBusy(false);
  }

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
          Your profile is ready{profile?.full_name ? `, ${profile.full_name.split(" ")[0]}` : ""}.{" "}
          {mode === "join"
            ? "Enter the join code from your manager to request access to their workspace."
            : "Register your business and a platform admin will approve it."}
        </p>

        {/* The reminder. Your account exists and has no company attached to it,
            which on a first sign-in reads as "nothing works" unless somebody
            says plainly what is missing and that only you can supply it. */}
        <div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
          <p className="text-xs font-medium text-warning-foreground">
            {wasRegistering
              ? "Your business still needs a name"
              : "Your account isn't attached to a company yet"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {wasRegistering
              ? "You're set up as an admin, but the company itself was never created. Name it below and a platform admin will approve it — nothing else on the app opens until then."
              : "Nothing opens until it is. Join your employer with their code, or name your own business to register it."}
          </p>
        </div>

        <div className="mt-4 inline-flex w-full rounded-lg bg-secondary p-1">
          {(["join", "create"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                mode === m
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {m === "join" ? "Join a company" : "Register a business"}
            </button>
          ))}
        </div>

        {mode === "create" && (
          <form className="mt-5 space-y-4" onSubmit={registerBusiness}>
            <div className="space-y-1.5">
              <Label htmlFor="company-name">Business name</Label>
              <Input
                id="company-name"
                autoFocus
                required
                maxLength={120}
                placeholder="e.g. Calexico Parking Enforcement"
                className="h-12"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                You'll be its admin. A platform admin approves the account before anyone can sign
                in — including you.
              </p>
            </div>

            {error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" className="h-11 w-full" disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Register business
            </Button>
          </form>
        )}

        <form
          className={`mt-5 space-y-4 ${mode === "join" ? "" : "hidden"}`}
          onSubmit={submit}
        >
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
