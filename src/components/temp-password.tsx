import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandLogo } from "@/components/brand";
import { useT } from "@/lib/i18n";
import { errorMessage } from "@/lib/error-message";

/**
 * Temporary passwords (see 20261202120000_admin_temp_password.sql).
 *
 * An admin gives a member a temporary password from Edit member; the member
 * signs in with it and is then held on `ChangePasswordGate` until they choose
 * their own. The database decides who may reset whom.
 */

const errorText = (e: unknown) => (errorMessage(e));

/** Edit member: set a temporary password and show it once. */
export function TempPasswordSection({ userId, name }: { userId: string; name: string }) {
  const t = useT("people");
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const issue = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("admin_set_temp_password", {
        _user: userId,
        ...(typed.trim() ? { _password: typed.trim() } : {}),
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (pw) => {
      setErr(null);
      setTyped("");
      setIssued(pw);
      setOpen(false);
    },
    onError: (e) => setErr(errorText(e)),
  });

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the password is on screen to read out instead */
    }
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium text-foreground">{t("Password")}</span>
      </div>

      {issued ? (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">
            {t("Give {name} this temporary password. It is shown only now.", { name })}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md bg-secondary px-3 py-2 font-mono text-base tracking-wider text-foreground">
              {issued}
            </code>
            <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? t("Copied") : t("Copy")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              "They have been signed out everywhere. After signing in with it they choose their own password.",
            )}
          </p>
        </div>
      ) : open ? (
        <div className="mt-2 space-y-2">
          <Label htmlFor="temp-password" className="text-xs">
            {t("Temporary password (leave empty to make one up)")}
          </Label>
          <Input
            id="temp-password"
            autoComplete="off"
            value={typed}
            maxLength={72}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t("At least 8 characters")}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => issue.mutate()}
              disabled={issue.isPending || (typed.trim().length > 0 && typed.trim().length < 8)}
            >
              {issue.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("Set password")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t("Forgot their password? Give them a temporary one to sign in with.")}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            {t("Set a temporary password")}
          </Button>
        </div>
      )}

      {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
    </div>
  );
}

/** Is the signed-in person on a temporary password? */
export function usePasswordChangeRequired() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["password-change-required", user?.id],
    enabled: !!user?.id,
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_password_change_required");
      // Before the migration is applied the function is missing: nobody is.
      if (error) return false;
      return data === true;
    },
  });
}

/** Holds someone on a temporary password until they choose their own. */
export function ChangePasswordGate({ onSignOut }: { onSignOut: () => void }) {
  const t = useT("shell");
  const { user } = useAuth();
  const qc = useQueryClient();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (pw.length < 8) throw new Error(t("Password must be at least 8 characters"));
      if (pw !== pw2) throw new Error(t("Passwords don't match"));
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
      const { error: doneErr } = await supabase.rpc("finish_password_change");
      if (doneErr) throw doneErr;
    },
    onSuccess: () => {
      setErr(null);
      qc.setQueryData(["password-change-required", user?.id], false);
    },
    onError: (e) => setErr(errorText(e)),
  });

  return (
    <div className="grid min-h-screen place-items-center bg-secondary/30 px-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-8 shadow-[var(--shadow-card)]"
      >
        <div className="flex justify-center">
          <BrandLogo className="h-14" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-foreground">{t("Choose your password")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "You signed in with a temporary password from your admin. Pick your own to keep using the app.",
            )}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-password">{t("New password")}</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-password-2">{t("Confirm new password")}</Label>
          <Input
            id="new-password-2"
            type="password"
            autoComplete="new-password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
          />
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
        <Button type="submit" className="w-full" disabled={save.isPending || !pw || !pw2}>
          {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("Save password")}
        </Button>
        <button
          type="button"
          onClick={onSignOut}
          className="block w-full text-center text-sm text-muted-foreground hover:text-foreground"
        >
          {t("Sign out")}
        </button>
      </form>
    </div>
  );
}
