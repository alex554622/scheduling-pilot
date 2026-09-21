import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import appCss from "../styles.css?url";
import { AuthProvider } from "@/lib/auth";

const DEFAULT_TITLE = "Scheduling Pilot | Employee Scheduling & Workforce Management Software";
const DEFAULT_DESCRIPTION =
  "Scheduling Pilot helps businesses create employee schedules, manage shifts, track time, handle time-off requests, and simplify workforce management from one easy platform.";

// Set VITE_GOOGLE_SITE_VERIFICATION in the build environment to have the
// verification tag rendered; leave it unset and nothing is emitted.
const GOOGLE_SITE_VERIFICATION = import.meta.env.VITE_GOOGLE_SITE_VERIFICATION as
  | string
  | undefined;

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    // Sitewide fallbacks. Every public page overrides title/description/robots
    // from src/lib/seo.ts; TanStack de-duplicates on name/property and the
    // deepest matched route wins, so these only apply where a route says nothing.
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: DEFAULT_TITLE },
      { name: "description", content: DEFAULT_DESCRIPTION },
      { name: "robots", content: "index, follow" },
      { name: "theme-color", content: "#ffffff" },
      // Home-screen install. The manifest covers Android and current iOS; the
      // apple-* tags are what older iOS reads to open full screen, not in Safari.
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Sched Pilot" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      // Verification code comes from the environment so no placeholder ships in
      // the repo. Unset means the tag is simply absent, which is a valid state.
      ...(GOOGLE_SITE_VERIFICATION
        ? [{ name: "google-site-verification", content: GOOGLE_SITE_VERIFICATION }]
        : []),
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/png", href: "/favicon.png" },
      { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

/**
 * Night mode, decided before the first paint. The app would otherwise draw one
 * white frame and then turn dark, which at night is the flash of light the
 * setting exists to avoid. Mirrors `@/lib/theme`, which it cannot import: same
 * storage key, same light-only paths.
 */
const THEME_BOOT = `(function(){try{var p=localStorage.getItem("sp-theme")||"light";var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var path=location.pathname;var light=["/","/about","/login","/join","/forgot-password","/reset-password","/employee-scheduling","/shift-trading","/time-clock","/time-off-management","/workforce-management"];if(d&&light.indexOf(path)<0&&path.indexOf("/clock/")!==0)document.documentElement.classList.add("dark")}catch(e){}})();`;

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    // The boot script may add `dark` before React hydrates, so the class list
    // is allowed to differ from what the server sent.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Outlet />
      </AuthProvider>
    </QueryClientProvider>
  );
}
