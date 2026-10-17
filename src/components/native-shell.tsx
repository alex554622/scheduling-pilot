import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { WifiOff } from "lucide-react";
import { useT } from "@/lib/i18n";
import { isNativeApp } from "@/lib/native/platform";
import { startNativeShell } from "@/lib/native/bootstrap";

/**
 * The parts of the Android/iOS apps that sit around every page: native wiring
 * (lib/native/bootstrap.ts) and a proper screen for having no connection.
 *
 * Every schedule, punch and message lives on the server, so with no network
 * the app has nothing true to show. Rather than half-loaded pages and raw
 * fetch errors, it says so plainly and comes back by itself when the
 * connection does. Renders nothing on the website.
 */
export function NativeShell() {
  const router = useRouter();
  const [online, setOnline] = useState(true);

  useEffect(() => {
    if (!isNativeApp()) return;
    startNativeShell(router);

    let remove: (() => void) | undefined;
    let cancelled = false;
    void import("@capacitor/network").then(async ({ Network }) => {
      const status = await Network.getStatus().catch(() => ({ connected: true }));
      if (cancelled) return;
      setOnline(status.connected);
      const handle = await Network.addListener("networkStatusChange", (s) => {
        setOnline((was) => {
          // Back online after a gap: reload what the pages showed, which may
          // have failed or gone stale while the connection was down.
          if (!was && s.connected) void router.invalidate();
          return s.connected;
        });
      });
      if (cancelled) void handle.remove();
      else remove = () => void handle.remove();
    });
    return () => {
      cancelled = true;
      remove?.();
    };
  }, [router]);

  if (online) return null;
  return <OfflineScreen onRetry={() => void router.invalidate()} />;
}

function OfflineScreen({ onRetry }: { onRetry: () => void }) {
  const t = useT("shell");
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="offline-title"
      aria-describedby="offline-body"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background px-6"
      style={{
        paddingTop: "var(--sat)",
        paddingBottom: "var(--sab)",
      }}
    >
      <div className="max-w-sm text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-secondary">
          <WifiOff className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
        </div>
        <h1 id="offline-title" className="mt-5 text-xl font-semibold text-foreground">
          {t("You're offline")}
        </h1>
        <p id="offline-body" className="mt-2 text-sm text-muted-foreground">
          {t(
            "Scheduling Pilot needs an internet connection to show your schedule and record punches. It will reconnect on its own as soon as you're back online.",
          )}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t("Try again")}
        </button>
      </div>
    </div>
  );
}
