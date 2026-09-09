import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { BrandLogo } from "@/components/brand";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setSent(true);
  }

  return (
    <div className="grid min-h-screen place-items-center bg-secondary/30 px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-[var(--shadow-card)]">
        <Link to="/" className="mb-6 flex items-center gap-2">
          <BrandLogo className="h-16" />
        </Link>

        <h1 className="mb-1 text-xl font-semibold text-foreground">Reset your password</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Enter your work email and we'll send a link to choose a new password.
        </p>

        {sent ? (
          <div className="space-y-4">
            <p className="rounded-md bg-primary-soft px-3 py-2 text-sm text-primary">
              If an account exists for <strong>{email}</strong>, a reset link is on its way. Check your inbox (and spam folder).
            </p>
            <Link to="/login" className="block text-sm text-primary hover:underline">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="email">Work email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Send reset link
            </Button>
            {error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
            )}
            <Link to="/login" className="block text-center text-sm text-muted-foreground hover:text-foreground">
              Back to sign in
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
