import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ChevronDown, Menu, X } from "lucide-react";
import { BrandLogo } from "@/components/brand";

type NavLink = { label: string; href?: string; to?: string };
type NavItem = NavLink & { items?: NavLink[] };

// `href` is an in-page anchor on the landing page; `to` is a router route.
const NAV: NavItem[] = [
  {
    label: "Product",
    items: [
      { label: "Employee scheduling", to: "/employee-scheduling" },
      { label: "Time clock", to: "/time-clock" },
      { label: "Time-off management", to: "/time-off-management" },
      { label: "Shift trading", to: "/shift-trading" },
      { label: "Workforce management", to: "/workforce-management" },
      { label: "Pricing", href: "/#pricing" },
    ],
  },
  { label: "Pricing", href: "/#pricing" },
  { label: "About", to: "/about" },
];

const FLAT_LINKS = Array.from(
  new Map(
    NAV.flatMap((item) => item.items ?? [item]).map((link) => [link.href ?? link.to, link]),
  ).values(),
);

function NavLinkItem({ link, onNavigate, className }: { link: NavLink; onNavigate?: () => void; className: string }) {
  if (link.to) {
    return (
      <Link to={link.to} onClick={onNavigate} className={className}>
        {link.label}
      </Link>
    );
  }
  return (
    <a href={link.href} onClick={onNavigate} className={className}>
      {link.label}
    </a>
  );
}

function DesktopNav() {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <nav className="hidden items-center gap-7 text-base lg:flex">
      {NAV.map((item) =>
        item.items ? (
          <div
            key={item.label}
            className="relative"
            onMouseEnter={() => setOpen(item.label)}
            onMouseLeave={() => setOpen(null)}
          >
            <button
              type="button"
              aria-expanded={open === item.label}
              onClick={() => setOpen((o) => (o === item.label ? null : item.label))}
              className="flex items-center gap-1 text-foreground/80 hover:text-foreground"
            >
              {item.label}
              <ChevronDown className="h-4 w-4" />
            </button>
            {open === item.label && (
              <div className="absolute left-0 top-full z-30 w-48 rounded-xl border border-border bg-card p-2 shadow-[var(--shadow-elev)]">
                {item.items.map((sub) => (
                  <NavLinkItem
                    key={sub.label}
                    link={sub}
                    onNavigate={() => setOpen(null)}
                    className="block rounded-lg px-3 py-2 text-sm text-foreground hover:bg-accent"
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <NavLinkItem
            key={item.label}
            link={item}
            className="text-foreground/80 hover:text-foreground"
          />
        ),
      )}
    </nav>
  );
}

/** The desktop nav is lg-only, so without this menu the links are unreachable on a phone or tablet. */
function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        className="grid h-11 w-11 place-items-center rounded-lg text-foreground hover:bg-accent"
      >
        {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
      </button>

      {open && (
        <div className="absolute inset-x-0 top-full z-40 border-y border-border bg-card p-4 shadow-[var(--shadow-elev)]">
          <nav className="flex flex-col">
            {FLAT_LINKS.map((link) => (
              <NavLinkItem
                key={link.href ?? link.to}
                link={link}
                onNavigate={() => setOpen(false)}
                className="rounded-lg px-3 py-3 text-base font-medium text-foreground hover:bg-accent"
              />
            ))}
            <Link
              to="/login"
              onClick={() => setOpen(false)}
              className="mt-2 rounded-lg border border-border px-3 py-3 text-center text-base font-medium text-foreground"
            >
              Log in
            </Link>
            <Link
              to="/login"
              search={{ mode: "signup", kind: "create" }}
              onClick={() => setOpen(false)}
              className="mt-2 rounded-lg bg-primary px-3 py-3 text-center text-base font-medium text-primary-foreground"
            >
              Create account
            </Link>
          </nav>
        </div>
      )}
    </div>
  );
}

export function MarketingHeader() {
  return (
    <header className="relative z-20">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-4 sm:px-6 sm:py-5 lg:gap-8">
        <Link to="/" className="shrink-0">
          <BrandLogo className="h-16 sm:h-20 lg:h-24" />
        </Link>
        <DesktopNav />
        <div className="ml-auto hidden shrink-0 items-center gap-5 lg:flex">
          <Link to="/login" className="text-base font-medium text-foreground hover:text-primary">
            Log in
          </Link>
          {/* `mode=signup` opens the sign-up form directly — landing on sign-in
              and asking people to hunt for a link loses them. */}
          <Link
            to="/login"
            search={{ mode: "signup", kind: "create" }}
            className="rounded-lg bg-primary px-4 py-2 text-base font-medium text-primary-foreground hover:opacity-90"
          >
            Create account
          </Link>
        </div>
        <div className="ml-auto lg:ml-0">
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
