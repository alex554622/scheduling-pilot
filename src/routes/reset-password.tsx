import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { BrandLogo } from "@/components/brand";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { noindexSeo } from "@/lib/seo";

export const Route = createFileRoute("/reset-password")({
  head: () => noindexSeo("Choose a new password | Scheduling Pilot", { follow: true }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Supabase recovery links land here with a session attached. Wait for the
  // PASSWORD_RECOVERY event (or an existing recovery session) before showing the form.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" && session) {
        setReady(true);
      }
    });

    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });

    // If after a short delay we still have no session, the link is invalid/expired.
    const timer = setTimeout(() => {
      void supabase.auth.getSession().then(({ data }) => {
        if (!data.session) {
          setRecoveryError(
            "This reset link is invalid or has expired. Request a new one from the forgot password page.",
          );
        }
      });
    }, 1500);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setDone(true);
    // Sign out so the user has to log in with the new password.
    await supabase.auth.signOut();
    setTimeout(() => navigate({ to: "/login" }), 1500);
  }

  return (
    <div className="grid min-h-screen place-items-center bg-secondary/30 px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-[var(--shadow-card)]">
        <Link to="/" className="mb-6 flex items-center gap-2">
          <BrandLogo className="h-16" />
        </Link>

        <h1 className="mb-1 text-xl font-semibold text-foreground">Choose a new password</h1>
        <p className="mb-6 text-sm text-muted-foreground">Pick something you haven't used before.</p>

        {recoveryError ? (
          <div className="space-y-4">
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{recoveryError}</p>
            <Link to="/forgot-password" className="block text-sm text-primary hover:underline">
              Request a new reset link
            </Link>
          </div>
        ) : done ? (
          <p className="rounded-md bg-primary-soft px-3 py-2 text-sm text-primary">
            Password updated. Redirecting to sign in…
          </p>
        ) : !ready ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Verifying reset link…
          </div>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                minLength={6}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm">Confirm new password</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                minLength={6}
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Update password
            </Button>
            {error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
