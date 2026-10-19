import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { MarketingHeader } from "@/components/marketing-header";
import { MarketingFooter } from "@/components/marketing-footer";
import { seo } from "@/lib/seo";
import { COMPANY_NAME, SUPPORT_EMAIL } from "@/lib/contact";

export const Route = createFileRoute("/privacy")({
  head: () =>
    seo({
      title: "Privacy Policy | Scheduling Pilot",
      description:
        "What Scheduling Pilot collects, why, who it is shared with, how long it is kept, and how to delete your account.",
      path: "/privacy",
    }),
  component: PrivacyPage,
});

/**
 * The privacy policy the website, the apps and both app stores link to.
 *
 * Written from what the code actually does (see docs/mobile/store-compliance.md,
 * section 4). When a feature starts collecting something new, this page, that
 * table and the store data forms change together.
 */
const UPDATED = "October 18, 2026";

function PrivacyPage() {
  const mail = (
    <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline">
      {SUPPORT_EMAIL}
    </a>
  );

  return (
    <div className="min-h-screen bg-background">
      <MarketingHeader />
      <main className="mx-auto max-w-3xl px-6 pb-20 pt-8 text-foreground">
        <h1 className="text-4xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="mt-3 text-sm text-muted-foreground">Last updated {UPDATED}</p>

        <Section title="Who we are">
          <p>
            Scheduling Pilot is employee scheduling and time-clock software made by {COMPANY_NAME},
            based in California, USA. This policy covers the website schedulingpilot.com and the
            Scheduling Pilot apps for Android and iPhone. Questions or requests: {mail}.
          </p>
          <p>
            Scheduling Pilot is used by businesses (our customers) to manage their staff. If your
            employer invited you, your employer decides what work information is entered about you
            and can see it, and we process that information to provide the service to them.
          </p>
        </Section>

        <Section title="What we collect">
          <ul>
            <li>
              <strong>Account details:</strong> your name, email address, password (stored only as a
              secure hash), your role, position and which company you belong to.
            </li>
            <li>
              <strong>Work records:</strong> schedules and shifts, clock-in and clock-out times,
              breaks, time-off requests, availability, shift trades, punch corrections and the
              messages you send to your company in the app.
            </li>
            <li>
              <strong>Precise location:</strong> only while the Time clock screen is open, to check
              that you are at your worksite and to record where each clock-in and clock-out
              happened. Company admins also use location to place a worksite on the map. Location is
              never collected in the background.
            </li>
            <li>
              <strong>Notification details:</strong> if you turn on notifications, a technical
              address for your device or browser so we can deliver them, and the notifications
              themselves (for example a shift reminder).
            </li>
            <li>
              <strong>Technical logs:</strong> our servers record basic information about requests,
              such as IP address, time and the action taken, to keep the service secure and working.
            </li>
          </ul>
          <p>
            Your hourly rate and tax settings for the earnings estimate stay on your device and are
            never sent to us. We do not use advertising, analytics or tracking tools, and we do not
            collect contacts, photos, camera, microphone or health information.
          </p>
        </Section>

        <Section title="How we use it">
          <p>
            Only to provide Scheduling Pilot: signing you in, showing schedules and timecards,
            running the time clock, delivering notifications and messages, answering support
            requests, and keeping the service secure. We do not sell your personal information,
            share it for advertising, or use it to build profiles about you.
          </p>
        </Section>

        <Section title="Who can see it and who we share it with">
          <ul>
            <li>
              <strong>Your company:</strong> admins and managers of the company you belong to can
              see your account details, work records and the location recorded with your punches.
              Coworkers can see the schedule and messages shared with them.
            </li>
            <li>
              <strong>Service providers</strong> that process data on our behalf: our hosting
              servers, where the database runs; Resend, which delivers sign-up and password-reset
              emails; and, if you turn on notifications, Google (Firebase Cloud Messaging), Apple
              (Push Notification service) or your web browser&apos;s push service, which deliver
              them to your device.
            </li>
            <li>
              <strong>Maps:</strong> map images come from OpenStreetMap. When a map is shown, your
              device requests the map tiles for that area from OpenStreetMap&apos;s servers, which
              see your IP address.
            </li>
            <li>
              <strong>Legal reasons:</strong> if the law requires it, or to protect the rights and
              safety of our users and the service.
            </li>
          </ul>
        </Section>

        <Section title="How long we keep it">
          <p>
            We keep your information for as long as your account exists. Read notifications are
            deleted about a day after they are read. When an account is deleted, its information is
            removed as described below; any copies in server backups are removed when those backups
            are replaced.
          </p>
        </Section>

        <Section title="Deleting your account">
          <p>
            You can delete your account at any time, in the app or on the website: sign in, open
            Settings and choose <strong>Delete account</strong>. This permanently deletes your login
            and profile together with your shifts, time punches, time-off requests, availability,
            shift trades and the messages you wrote. Instructions are also at{" "}
            <Link to="/delete-account" className="text-primary underline">
              schedulingpilot.com/delete-account
            </Link>
            . If you cannot sign in, email {mail} from the address on your account.
          </p>
        </Section>

        <Section title="Security">
          <p>
            All connections to Scheduling Pilot are encrypted (HTTPS). Access to data is limited by
            account and company, so people only see the information their role allows. In the apps,
            your sign-in is stored in the app&apos;s private storage on your device; on Android it
            is also left out of device backups.
          </p>
        </Section>

        <Section title="Your California privacy rights">
          <p>
            If you live in California, the California Consumer Privacy Act (as amended by the CPRA)
            gives you the right to:
          </p>
          <ul>
            <li>know what personal information we have collected about you and how it is used;</li>
            <li>get a copy of it;</li>
            <li>have it corrected or deleted;</li>
            <li>not be treated differently for using these rights.</li>
          </ul>
          <p>
            In the categories the law uses, we collect identifiers (name, email, account ID),
            professional or employment-related information (position, schedules, time records), and
            precise geolocation as described above, from you and from your employer. We use precise
            geolocation only to provide the time clock. We do not sell or share personal information
            as those terms are defined by the law.
          </p>
          <p>
            To make a request, email {mail}. We will confirm your identity using the email address
            on your account, and an authorized agent may make a request for you with your written
            permission. We respond within 45 days.
          </p>
        </Section>

        <Section title="Children">
          <p>
            Scheduling Pilot is a workplace tool and is not directed to children under 13. We do not
            knowingly collect information from children under 13.
          </p>
        </Section>

        <Section title="Changes to this policy">
          <p>
            If we change this policy, we will update the date at the top of this page. If a change
            is significant, we will also tell you in the app or by email.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            {COMPANY_NAME}, California, USA. Email: {mail}.
          </p>
        </Section>
      </main>
      <MarketingFooter />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10 space-y-3 text-[15px] leading-relaxed text-muted-foreground [&_li]:ml-5 [&_li]:list-disc [&_li]:pl-1 [&_strong]:text-foreground [&_ul]:space-y-2">
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}
