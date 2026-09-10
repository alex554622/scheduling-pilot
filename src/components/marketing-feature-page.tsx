import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";
import { MarketingHeader } from "@/components/marketing-header";
import { MarketingFooter } from "@/components/marketing-footer";
import { Decorations } from "@/components/showcase";

// Shared shell for the feature pages. Only the layout is shared — every page
// supplies its own copy, so the pages differ in substance rather than being one
// template with the nouns swapped.

export interface FeatureBlock {
  icon: LucideIcon;
  title: string;
  desc: string;
}

export interface FeatureSection {
  heading: string;
  intro?: string;
  blocks?: FeatureBlock[];
  steps?: { title: string; desc: string }[];
  paragraphs?: string[];
}

export interface RelatedLink {
  to: string;
  label: string;
  blurb: string;
}

interface FeaturePageProps {
  h1: string;
  lede: string;
  /** Second paragraph under the H1 — the place for supporting detail. */
  sublede?: string;
  sections: FeatureSection[];
  related: RelatedLink[];
  ctaHeading: string;
  ctaBody: string;
}

export function FeaturePage({
  h1,
  lede,
  sublede,
  sections,
  related,
  ctaHeading,
  ctaBody,
}: FeaturePageProps) {
  return (
    <div className="min-h-screen bg-background">
      <MarketingHeader />

      <main>
        <section className="relative isolate overflow-hidden">
          <Decorations />
          <div className="relative z-10 mx-auto max-w-3xl px-6 pb-14 pt-8">
            <h1 className="text-balance text-4xl font-semibold leading-[1.1] tracking-tight text-foreground sm:text-5xl">
              {h1}
            </h1>
            <p className="mt-5 text-pretty text-lg leading-relaxed text-muted-foreground">{lede}</p>
            {sublede && (
              <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">{sublede}</p>
            )}
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to="/login"
                search={{ mode: "signup", kind: "create" }}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Create a free account <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/about"
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground hover:bg-accent"
              >
                See everything it does
              </Link>
            </div>
          </div>
        </section>

        {sections.map((section) => (
          <section key={section.heading} className="border-t border-border">
            <div className="mx-auto max-w-6xl px-6 py-16">
              <h2 className="text-2xl font-semibold text-foreground sm:text-3xl">
                {section.heading}
              </h2>
              {section.intro && (
                <p className="mt-3 max-w-3xl text-pretty leading-relaxed text-muted-foreground">
                  {section.intro}
                </p>
              )}

              {section.paragraphs?.map((p) => (
                <p
                  key={p}
                  className="mt-4 max-w-3xl text-pretty leading-relaxed text-muted-foreground"
                >
                  {p}
                </p>
              ))}

              {section.blocks && (
                <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {section.blocks.map((b) => (
                    <div
                      key={b.title}
                      className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-card)]"
                    >
                      <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary-soft text-primary">
                        <b.icon className="h-5 w-5" />
                      </div>
                      <h3 className="mt-4 font-semibold text-foreground">{b.title}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{b.desc}</p>
                    </div>
                  ))}
                </div>
              )}

              {section.steps && (
                <ol className="mt-8 grid gap-4 sm:grid-cols-2">
                  {section.steps.map((s, i) => (
                    <li
                      key={s.title}
                      className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-card)]"
                    >
                      <span className="grid h-8 w-8 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary">
                        {i + 1}
                      </span>
                      <h3 className="mt-3 font-semibold text-foreground">{s.title}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.desc}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        ))}

        <section className="border-t border-border bg-secondary/40">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="text-2xl font-semibold text-foreground sm:text-3xl">
              Explore the rest of Scheduling Pilot
            </h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {related.map((r) => (
                <Link
                  key={r.to}
                  to={r.to}
                  className="group rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-card)] hover:border-primary/50"
                >
                  <h3 className="font-semibold text-foreground group-hover:text-primary">
                    {r.label}
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{r.blurb}</p>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-border">
          <div className="mx-auto max-w-3xl px-6 py-16 text-center">
            <h2 className="text-2xl font-semibold text-foreground sm:text-3xl">{ctaHeading}</h2>
            <p className="mt-3 text-pretty leading-relaxed text-muted-foreground">{ctaBody}</p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <Link
                to="/login"
                search={{ mode: "signup", kind: "create" }}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Create a free account <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/login"
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground hover:bg-accent"
              >
                Log in
              </Link>
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
