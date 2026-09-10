import { createFileRoute, Link } from "@tanstack/react-router";
import { Calendar, Users, RefreshCw, Shield, CheckCircle2, Banknote, CreditCard, TrendingUp, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { planBullets, seatLine } from "@/lib/capabilities";
import { APP_NAME } from "@/components/brand";
import { DashboardPreview, Decorations } from "@/components/showcase";
import { MarketingHeader } from "@/components/marketing-header";
import { MarketingFooter } from "@/components/marketing-footer";
import { seo, SITE_URL } from "@/lib/seo";

const HOME_TITLE = "Scheduling Pilot | Employee Scheduling & Workforce Management Software";
const HOME_DESCRIPTION =
  "Scheduling Pilot helps businesses create employee schedules, manage shifts, track time, handle time-off requests, and simplify workforce management from one easy platform.";

// Structured data. Deliberately limited to facts that are true and verifiable
// from the site itself — no ratings, review counts, customer numbers or prices,
// all of which would be fabricated and are exactly what Google penalises.
const SOFTWARE_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: APP_NAME,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  url: `${SITE_URL}/`,
  description: HOME_DESCRIPTION,
  featureList: [
    "Employee scheduling",
    "Shift management",
    "Employee time clock",
    "Time-off management",
    "Shift trading",
    "Workforce reporting",
  ],
};

const ORGANIZATION_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: APP_NAME,
  url: `${SITE_URL}/`,
  logo: `${SITE_URL}/scheduling-pilot-logo.png`,
};

export const Route = createFileRoute("/")({
  head: () => ({
    ...seo({ title: HOME_TITLE, description: HOME_DESCRIPTION, path: "/" }),
    // Rendered, not executed: TanStack treats any script whose type is neither
    // text/javascript nor module as inert data, which is what JSON-LD needs.
    scripts: [
      { type: "application/ld+json", children: JSON.stringify(SOFTWARE_SCHEMA) },
      { type: "application/ld+json", children: JSON.stringify(ORGANIZATION_SCHEMA) },
    ],
  }),
  component: Landing,
});

const HERO_POINTS = [
  {
    icon: Calendar,
    title: "Automate & Save Time",
    desc: "Reduce manual work and eliminate scheduling conflicts.",
  },
  {
    icon: TrendingUp,
    title: "Optimize Coverage",
    desc: "Ensure the right people are in the right place, every time.",
  },
  {
    icon: Users,
    title: "Empower Your Team",
    desc: "Increase transparency and give your team more control.",
  },
];

interface Plan {
  id: string;
  name: string;
  price_cents: number;
  features: string[];
  capabilities: unknown;
  max_employees: number | null;
  featured: boolean;
  sort_order: number;
}

function Landing() {
  const [paymentsEnabled, setPaymentsEnabled] = useState(false);
  // Falls back to 30 for a visitor who can't read app_settings, so the card
  // never advertises a trial length of zero by accident.
  const [trialDays, setTrialDays] = useState(30);
  const [plans, setPlans] = useState<Plan[]>([]);

  const loadPlans = () => {
    supabase.from("pricing_plans")
      .select("id, name, price_cents, features, featured, sort_order, capabilities, max_employees")
      // A public page shows only what a super admin has made visible. Plans are
      // created and edited in Platform → Subscription plans, never here.
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .then(({ data }) => {
        if (data) setPlans(data as unknown as Plan[]);
      });
  };

  useEffect(() => {
    let active = true;
    supabase.from("app_settings").select("key, value").in("key", ["payments_enabled", "trial_days"]).then(({ data }) => {
      if (!active || !data) return;
      const byKey = new Map(data.map((r) => [r.key, r.value]));
      setPaymentsEnabled(byKey.get("payments_enabled") === true);
      const days = Number(byKey.get("trial_days"));
      if (Number.isFinite(days)) setTrialDays(days);
    });
    loadPlans();
    const ch = supabase.channel("settings-payments")
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings", filter: "key=eq.payments_enabled" },
        (p) => setPaymentsEnabled((p.new as { value: unknown })?.value === true))
      .subscribe();
    return () => { active = false; supabase.removeChannel(ch); };
  }, []);


  return (
    <div className="min-h-screen bg-background">
      <MarketingHeader />

      <main>
      <section className="relative isolate overflow-hidden">
        <Decorations />
        <div className="relative z-10 mx-auto grid max-w-7xl items-center gap-14 px-6 pb-16 pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <div className="min-w-0">
            <h1 className="text-balance text-5xl font-semibold leading-[1.1] tracking-tight text-foreground sm:text-6xl">
              Employee scheduling
              <br />
              made <span className="text-primary">simple</span>
            </h1>
            <p className="mt-6 max-w-md text-pretty text-lg leading-relaxed text-muted-foreground">
              Create schedules, manage shifts, track employee time, approve time-off requests, and
              keep your team organized with {APP_NAME}.
            </p>

            <ul className="mt-10 space-y-7">
              {HERO_POINTS.map((point) => (
                <li key={point.title} className="flex gap-4">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-primary/20 bg-primary-soft/60">
                    <point.icon className="h-5 w-5 text-primary" />
                  </span>
                  <div>
                    <p className="font-semibold text-foreground">{point.title}</p>
                    <p className="mt-1 max-w-xs text-sm leading-relaxed text-muted-foreground">
                      {point.desc}
                    </p>
                  </div>
                </li>
              ))}
            </ul>

          </div>

          <DashboardPreview />
        </div>

        <p className="relative z-10 pb-16 text-center text-lg font-semibold text-muted-foreground">
          Powered by Valladolid NovaTech
        </p>
      </section>

      <section id="features" className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <h2 className="text-3xl font-semibold text-foreground">
            Everything a shift-based team needs
          </h2>
          <p className="mt-2 text-muted-foreground">
            Scheduling, time tracking, trades and time off in one place.
          </p>
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: Calendar, title: "Schedule builder", desc: "Drag-and-drop weekly grids, copy to month, full-year planning." },
            { icon: RefreshCw, title: "Shift trades", desc: "Employees swap with one tap. Admins approve with full context." },
            { icon: Users, title: "Time-off & availability", desc: "Vacation, sick, personal — all visible at the moment of scheduling." },
            { icon: Shield, title: "Multi-tenant security", desc: "Per-company isolation with role-based access for every action." },
          ].map((f) => (
            <div key={f.title} className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-card)]">
              <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary-soft text-primary">
                <f.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 font-semibold text-foreground">{f.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="border-t border-border bg-secondary/40">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="text-center">
            <h2 className="text-3xl font-semibold text-foreground">Simple monthly pricing</h2>
            <p className="mt-2 text-muted-foreground">Pay as your team grows.</p>
            <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
              {paymentsEnabled ? (
                <><CreditCard className="h-3.5 w-3.5 text-primary" /> Card payments enabled</>
              ) : (
                <><Banknote className="h-3.5 w-3.5 text-primary" /> Currently cash / invoice billing — card payments coming soon</>
              )}
            </div>
          </div>
          {/* Plans are created and edited in Platform → Subscription plans,
              where capabilities and seat caps live. This page only shows them. */}
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {plans.map((p) => (
              <div
                key={p.id}
                className={`relative rounded-xl border bg-card p-6 ${p.featured ? "border-primary shadow-[var(--shadow-elev)]" : "border-border shadow-[var(--shadow-card)]"}`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-foreground">{p.name}</h3>
                  {p.featured && <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">Popular</span>}
                </div>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="text-4xl font-semibold text-foreground">${(p.price_cents / 100).toFixed(0)}</span>
                  <span className="text-sm text-muted-foreground">/month</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{seatLine(p.max_employees)}</p>
                <ul className="mt-5 space-y-2 text-sm text-foreground">
                  {planBullets(p.capabilities, p.features).map((feat) => (
                    <li key={feat} className="flex items-start gap-2">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
                      {feat}
                    </li>
                  ))}
                </ul>
                {/* Every plan starts on the same free trial, so this is the real
                    call to action — the payment button below stays secondary
                    until Stripe is wired up. */}
                {trialDays > 0 && (
                  <Link
                    to="/login"
                    search={{ mode: "signup", kind: "create" }}
                    className={`mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${p.featured ? "bg-primary text-primary-foreground hover:opacity-90" : "border border-primary/40 bg-primary-soft text-primary hover:bg-primary-soft/70"}`}
                  >
                    <Sparkles className="h-4 w-4" />
                    Try free for {trialDays} days
                  </Link>
                )}
                {paymentsEnabled ? (
                  <button
                    type="button"
                    onClick={() => {
                      // Stripe Checkout entry point — only reachable when Super Admin
                      // has enabled card payments. Until Stripe is wired up, route to login.
                      window.location.href = "/login";
                    }}
                    className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
                  >
                    <CreditCard className="h-4 w-4" /> Subscribe with card
                  </button>
                ) : (
                  <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                    <Banknote className="h-3.5 w-3.5" /> Then cash or invoice billing
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      </main>

      <MarketingFooter />
    </div>
  );
}
