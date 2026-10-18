import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Apple, Download, ShieldCheck, Smartphone } from "lucide-react";
import { MarketingHeader } from "@/components/marketing-header";
import { MarketingFooter } from "@/components/marketing-footer";
import { seo } from "@/lib/seo";

export const Route = createFileRoute("/download")({
  head: () =>
    seo({
      title: "Download the Scheduling Pilot app",
      description:
        "Install Scheduling Pilot on an Android phone or tablet, or add it to an iPhone's Home Screen.",
      path: "/download",
    }),
  component: DownloadPage,
});

/**
 * The Android APK is built by .github/workflows/android-release.yml and uploaded
 * by hand to the public `downloads` bucket in Supabase Storage, next to the
 * latest.json that run produced (docs/mobile/android-apk.md). Nothing about the
 * release is written into this page, so publishing a new APK needs no redeploy.
 */
const ANDROID_DIR = `${import.meta.env.VITE_SUPABASE_URL as string}/storage/v1/object/public/downloads/android`;

interface Release {
  versionName: string;
  versionCode: number;
  sha256: string;
  sizeBytes: number;
  builtAt: string;
}

type State = { kind: "loading" } | { kind: "none" } | { kind: "ready"; release: Release };

function DownloadPage() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(`${ANDROID_DIR}/latest.json`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Release>) : null))
      .then((release) => {
        if (cancelled) return;
        setState(release?.versionName ? { kind: "ready", release } : { kind: "none" });
      })
      .catch(() => !cancelled && setState({ kind: "none" }));
    return () => {
      cancelled = true;
    };
  }, []);

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

            {state.kind === "loading" && (
              <p className="mt-4 text-sm text-muted-foreground">Checking for the latest version…</p>
            )}

            {state.kind === "none" && (
              <p className="mt-4 text-sm text-muted-foreground">
                The Android app isn't available for download yet. Check back soon.
              </p>
            )}

            {state.kind === "ready" && (
              <>
                <p className="mt-4 text-sm text-muted-foreground">
                  Version {state.release.versionName} ·{" "}
                  {(state.release.sizeBytes / 1_048_576).toFixed(1)} MB · Android 7.0 or later
                </p>
                <a
                  href={`${ANDROID_DIR}/scheduling-pilot.apk?v=${state.release.versionCode}`}
                  download="scheduling-pilot.apk"
                  className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  Download for Android (APK)
                </a>

                <h3 className="mt-6 text-sm font-semibold text-foreground">How to install</h3>
                <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                  <li>Open this page on your Android phone and tap the download button.</li>
                  <li>
                    When the download finishes, open the file from the notification or Downloads.
                  </li>
                  <li>
                    If Android asks, allow your browser to install apps (“Install unknown apps”),
                    then go back and tap <strong>Install</strong>.
                  </li>
                  <li>Open Sched Pilot and sign in.</li>
                </ol>
                <p className="mt-3 text-sm text-muted-foreground">
                  To update, download and install the new version over the old one. You stay signed
                  in.
                </p>

                <details className="mt-4 text-xs text-muted-foreground">
                  <summary className="flex cursor-pointer items-center gap-1.5">
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    Verify the download
                  </summary>
                  <p className="mt-2">
                    SHA-256:{" "}
                    <code className="break-all rounded bg-secondary px-1 py-0.5 text-foreground">
                      {state.release.sha256}
                    </code>
                  </p>
                  <p className="mt-1">
                    Built {new Date(state.release.builtAt).toLocaleDateString()}. Only install the
                    app from schedulingpilot.com.
                  </p>
                </details>
              </>
            )}
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
