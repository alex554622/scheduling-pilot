import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SUPPORT_EMAIL } from "@/lib/contact";

/** Where someone who can't sign in asks for their account to be deleted. */
export { SUPPORT_EMAIL };

/** The word typed to confirm. Kept in English in both languages, like a code. */
const CONFIRM_WORD = "DELETE";

/**
 * `delete_my_account` (supabase/migrations/20261017120000_delete_my_account.sql)
 * isn't in the generated types yet, so it is called through a loose signature.
 */
const deleteMyAccount = () =>
  (
    supabase.rpc as unknown as (
      fn: string,
    ) => PromiseLike<{ error: { code?: string; message: string } | null }>
  )("delete_my_account");

/**
 * Anyone can delete their own account — required by the App Store and Google
 * Play, and the same deletion a platform admin does from Accounts. Used in
 * Settings and on the public /delete-account page.
 */
export function DeleteAccountCard() {
  const t = useT("shell");
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function explain(err: { code?: string; message: string }): string {
    if (/last platform admin/i.test(err.message)) {
      return t("You're the last platform admin. Make someone else a platform admin first.");
    }
    if (/someone else a company admin/i.test(err.message)) {
      return t(
        "You're the only admin of a company that still has members. Make someone else a company admin first, in Employees.",
      );
    }
    // The function isn't on this server yet: say so rather than show SQL errors.
    if (err.code === "PGRST202" || err.code === "42883") {
      return t(
        "Account deletion isn't available right now. Email {email} and we'll delete it for you.",
        {
          email: SUPPORT_EMAIL,
        },
      );
    }
    return t("Your account wasn't deleted: {message}", { message: err.message });
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    const { error: err } = await deleteMyAccount();
    if (err) {
      setError(explain(err));
      setBusy(false);
      return;
    }
    // The account no longer exists, so there is no server session left to end;
    // only this device's copy of it is cleared.
    await supabase.auth.signOut({ scope: "local" }).catch(() => {});
    await navigate({ to: "/delete-account", search: { done: true }, replace: true });
  }

  return (
    <div className="rounded-xl border border-destructive/30 bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="mb-3 flex items-center gap-2">
        <Trash2 className="h-5 w-5 text-destructive" aria-hidden="true" />
        <h3 className="font-semibold text-foreground">{t("Delete account")}</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        {t(
          "Permanently deletes your login and profile, together with your shifts, time punches, time-off requests, availability, shift trades and the messages you wrote. This can't be undone.",
        )}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        {t(
          "If you or your employer need your timecards, download them as PDF before you delete your account.",
        )}
      </p>
      <div className="mt-4 flex justify-end">
        <Button
          variant="outline"
          className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => {
            setTyped("");
            setError(null);
            setOpen(true);
          }}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          {t("Delete my account")}
        </Button>
      </div>

      <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Delete your account for good?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Your login, profile, shifts, time punches, time-off requests, availability, shift trades and messages are deleted right away, and you are signed out on every device.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="delete-confirm">
              {t("Type {word} to confirm", { word: CONFIRM_WORD })}
            </Label>
            <Input
              id="delete-confirm"
              value={typed}
              autoComplete="off"
              autoCapitalize="characters"
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
            />
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("Cancel")}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={busy || typed.trim().toUpperCase() !== CONFIRM_WORD}
              onClick={() => void confirm()}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {t("Delete my account")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
