import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Apple, Download, Smartphone } from "lucide-react";
import { MarketingHeader } from "@/components/marketing-header";
import { MarketingFooter } from "@/components/marketing-footer";
import { seo } from "@/lib/seo";

export const Route = createFileRoute("/download")({
  head: () =>
    seo({
      title: "Download the Scheduling Pilot app",
      description:
        "Add Scheduling Pilot to the Home Screen of an Android or iPhone phone or tablet.",
      path: "/download",
    }),
  component: DownloadPage,
});

/** Chrome's install offer (not in the DOM typings yet). */
interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function DownloadPage() {
  // Chrome on Android (and desktop) offers a one-tap install when it can.
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallPrompt);
    };
    const onInstalled = () => {
      setInstall(null);
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const installNow = async () => {
    if (!install) return;
    await install.prompt();
    const { outcome } = await install.userChoice;
    setInstall(null);
    if (outcome === "accepted") setInstalled(true);
  };

  return (
    <div className="min-h-screen bg-background">
      <MarketingHeader />

      <main className="mx-auto max-w-4xl px-6 pb-20 pt-8">
        <h1 className="text-balance text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Get the <span className="text-primary">app</span>
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
          Scheduling Pilot on your phone: your schedule, the time clock, shift trades and time off.
          Sign in with the same account you use on this website.
        </p>

        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <section
            aria-labelledby="android-heading"
            className="rounded-2xl border border-border bg-card p-6 shadow-[var(--shadow-card)]"
          >
            <div className="flex items-center gap-2">
              <Smartphone className="h-5 w-5 text-primary" aria-hidden="true" />
              <h2 id="android-heading" className="text-lg font-semibold text-foreground">
                Android
              </h2>
            </div>

            <p className="mt-4 text-sm text-muted-foreground">
              Add Scheduling Pilot to your Home Screen. It opens full screen like an app, can send
              notifications and always has the latest version, with nothing to download:
            </p>
            {install && (
              <button
                type="button"
                onClick={() => void installNow()}
                className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                Install app
              </button>
            )}
            {installed && (
              <p className="mt-4 text-sm font-medium text-primary">
                Installed. Open it from your Home Screen.
              </p>
            )}
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>Open schedulingpilot.com in Chrome.</li>
              <li>
                Tap the <strong>⋮</strong> menu, then <strong>Add to Home screen</strong> (or{" "}
                <strong>Install app</strong>).
              </li>
              <li>Open it from your Home Screen and sign in.</li>
            </ol>
            <Link
              to="/login"
              className="mt-5 inline-flex min-h-11 items-center justify-center rounded-md border border-input bg-background px-5 py-2 text-sm font-medium text-foreground hover:bg-accent"
            >
              Sign in on the web
            </Link>
          </section>

          <section
            aria-labelledby="iphone-heading"
            className="rounded-2xl border border-border bg-card p-6 shadow-[var(--shadow-card)]"
          >
            <div className="flex items-center gap-2">
              <Apple className="h-5 w-5 text-primary" aria-hidden="true" />
              <h2 id="iphone-heading" className="text-lg font-semibold text-foreground">
                iPhone and iPad
              </h2>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Apple only allows apps to be installed from the App Store, so there is no file to
              download for iPhone. Until the app is in the App Store, add Scheduling Pilot to your
              Home Screen — it opens full screen like an app and can send notifications:
            </p>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>Open schedulingpilot.com in Safari.</li>
              <li>
                Tap the <strong>Share</strong> button, then <strong>Add to Home Screen</strong>.
              </li>
              <li>Open it from your Home Screen and sign in.</li>
            </ol>
            <Link
              to="/login"
              className="mt-5 inline-flex min-h-11 items-center justify-center rounded-md border border-input bg-background px-5 py-2 text-sm font-medium text-foreground hover:bg-accent"
            >
              Sign in on the web
            </Link>
          </section>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
