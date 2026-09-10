import { Link } from "@tanstack/react-router";
import { APP_NAME } from "@/components/brand";

// Every marketing page ends with the same link block. Beyond being useful to a
// reader, it is what makes the feature pages reachable in one hop from anywhere
// on the public site — an orphaned page is a page Google is slow to index.
export const FEATURE_LINKS = [
  { to: "/employee-scheduling", label: "Employee scheduling software" },
  { to: "/time-clock", label: "Employee time clock" },
  { to: "/time-off-management", label: "Time-off management" },
  { to: "/shift-trading", label: "Shift trading" },
  { to: "/workforce-management", label: "Workforce management" },
] as const;

export function MarketingFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <nav aria-label="Product features" className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Features</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {FEATURE_LINKS.map((l) => (
                <li key={l.to}>
                  <Link to={l.to} className="text-muted-foreground hover:text-primary">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="text-sm font-semibold text-foreground">Company</h2>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                <Link to="/" className="text-muted-foreground hover:text-primary">
                  Employee scheduling home
                </Link>
              </li>
              <li>
                <Link to="/about" className="text-muted-foreground hover:text-primary">
                  What Scheduling Pilot does
                </Link>
              </li>
              <li>
                <a href="/#pricing" className="text-muted-foreground hover:text-primary">
                  Pricing plans
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-sm font-semibold text-foreground">Get started</h2>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                <Link
                  to="/login"
                  search={{ mode: "signup", kind: "create" }}
                  className="text-muted-foreground hover:text-primary"
                >
                  Create a company account
                </Link>
              </li>
              <li>
                <Link to="/login" className="text-muted-foreground hover:text-primary">
                  Log in to Scheduling Pilot
                </Link>
              </li>
            </ul>
          </div>
        </nav>
      </div>

      <div className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-muted-foreground sm:flex-row">
          <span>© 2026 {APP_NAME}</span>
          <span>Powered by Valladolid NovaTech</span>
        </div>
      </div>
    </footer>
  );
}
