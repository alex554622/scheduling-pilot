import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { CheckCircle2, Loader2 } from "lucide-react";
import { BrandLogo } from "@/components/brand";
import { DeleteAccountCard, SUPPORT_EMAIL } from "@/components/delete-account";
import { useAuth } from "@/lib/auth";
import { noindexSeo } from "@/lib/seo";
import { useT } from "@/lib/i18n";

const searchSchema = z.object({
  /** Set by DeleteAccountCard once the account is gone. */
  done: z.boolean().optional(),
});

/**
 * How to delete a Scheduling Pilot account, at a public address. Google Play
 * asks for this URL so people can find it without the app installed; the App
 * Store's in-app requirement is met by the same card in Settings.
 */
export const Route = createFileRoute("/delete-account")({
  validateSearch: (s) => searchSchema.parse(s),
  head: () => noindexSeo("Delete your account | Scheduling Pilot", { follow: true }),
  component: DeleteAccountPage,
});

function DeleteAccountPage() {
  const t = useT("shell");
  const { done } = Route.useSearch();
  const { user, loading } = useAuth();

  return (
    <div className="grid min-h-screen place-items-center bg-secondary/30 px-4 py-10">
      <div className="w-full max-w-lg space-y-6">
        <div className="rounded-2xl border border-border bg-card p-8 shadow-[var(--shadow-card)]">
          <Link to="/" className="mb-6 flex items-center gap-2">
            <BrandLogo className="h-16" />
          </Link>

          {done ? (
            <div className="space-y-3">
              <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
                <CheckCircle2 className="h-5 w-5 text-primary" aria-hidden="true" />
                {t("Your account has been deleted")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t(
                  "Your login and the data that belonged to it have been removed from Scheduling Pilot. Thank you for using it.",
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <h1 className="text-xl font-semibold text-foreground">
                {t("Delete your Scheduling Pilot account")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t(
                  "You can delete your account yourself at any time, in the app or on this website: sign in, open Settings, and choose Delete account at the bottom of the page.",
                )}
              </p>
              <p className="text-sm text-muted-foreground">
                {t(
                  "Deleting removes your login and profile together with your shifts, time punches, time-off requests, availability, shift trades and the messages you wrote. It happens straight away and can't be undone.",
                )}
              </p>
              <p className="text-sm text-muted-foreground">
                {t(
                  "Can't sign in? Email {email} from the address on your account and we'll delete it for you.",
                  {
                    email: SUPPORT_EMAIL,
                  },
                )}
              </p>
            </div>
          )}
        </div>

        {!done &&
          (loading ? (
            <div className="flex justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" aria-label={t("Loading…")} />
            </div>
          ) : user ? (
            <DeleteAccountCard />
          ) : (
            <div className="text-center">
              <Link
                to="/login"
                className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t("Sign in to delete your account")}
              </Link>
            </div>
          ))}
      </div>
    </div>
  );
}
