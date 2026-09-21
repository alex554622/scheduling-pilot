import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, ROLE_LABEL } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Loader2,
  Check,
  KeyRound,
  UserCog,
  Building2,
  Copy,
  Bell,
  Moon,
  Sun,
  MonitorSmartphone,
} from "lucide-react";
import { useThemePref, type ThemePref } from "@/lib/theme";
import { playChime } from "@/lib/notify-sound";
import { Switch } from "@/components/ui/switch";
import {
  NOTIFICATION_TYPES,
  desktopPermission,
  isStandalone,
  requestDesktopPermission,
  useNotificationPrefs,
} from "@/lib/notification-prefs";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const { user, profile, primaryRole, company, refresh, loading } = useAuth();
  const [fullName, setFullName] = useState("");
  const [position, setPosition] = useState("");
  const [savedProfile, setSavedProfile] = useState(false);
  const [profileErr, setProfileErr] = useState<string | null>(null);

  useEffect(() => {
    if (profile) {
      setFullName(profile.full_name ?? "");
      setPosition(profile.position ?? "");
    }
  }, [profile]);

  const saveProfile = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: fullName.trim(), position: position.trim() || null })
        .eq("id", user!.id);
      if (error) throw error;
      await refresh();
    },
    onSuccess: () => {
      setSavedProfile(true);
      setProfileErr(null);
      setTimeout(() => setSavedProfile(false), 1500);
    },
    onError: (e: unknown) => setProfileErr(e instanceof Error ? e.message : String(e)),
  });

  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwOk, setPwOk] = useState(false);

  const changePw = useMutation({
    mutationFn: async () => {
      if (pw.length < 8) throw new Error("Password must be at least 8 characters");
      if (pw !== pw2) throw new Error("Passwords don't match");
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
    },
    onSuccess: () => {
      setPw("");
      setPw2("");
      setPwErr(null);
      setPwOk(true);
      setTimeout(() => setPwOk(false), 2000);
    },
    onError: (e: unknown) => setPwErr(e instanceof Error ? e.message : String(e)),
  });

  const canSeeCode = primaryRole === "company_admin" || primaryRole === "super_admin";
  const [copied, setCopied] = useState(false);

  // Company name. The existing company_admin_update policy already lets an admin
  // update their own company row (the same route timezone and worksite settings
  // take), so this needs no new database work.
  const [companyName, setCompanyName] = useState("");
  const [companyErr, setCompanyErr] = useState<string | null>(null);
  const [companySaved, setCompanySaved] = useState(false);

  useEffect(() => {
    if (company) setCompanyName(company.name ?? "");
  }, [company]);

  const saveCompanyName = useMutation({
    mutationFn: async () => {
      const next = companyName.trim();
      // `name` is NOT NULL but an empty string would satisfy that, leaving the
      // company nameless everywhere it is displayed.
      if (!next) throw new Error("Organization name can't be empty");
      if (next.length > 120) throw new Error("Organization name must be 120 characters or fewer");
      if (next === company?.name) return;

      const { error } = await supabase
        .from("companies")
        .update({ name: next })
        .eq("id", company!.id);
      if (error) throw error;
      // Refresh so the sidebar, header and every "Company: …" label pick up the
      // new name without a reload.
      await refresh();
    },
    onSuccess: () => {
      setCompanyErr(null);
      setCompanySaved(true);
      setTimeout(() => setCompanySaved(false), 1500);
    },
    onError: (e: unknown) => setCompanyErr(e instanceof Error ? e.message : String(e)),
  });

  const companyNameDirty = !!company && companyName.trim() !== company.name;

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Settings</h2>
        <p className="text-sm text-muted-foreground">Manage your profile and password.</p>
      </div>

      {canSeeCode && company && (
        <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
          <div className="mb-4 flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            <h3 className="font-semibold text-foreground">Organization name</h3>
          </div>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="company-name">Organization name</Label>
              <Input
                id="company-name"
                value={companyName}
                maxLength={120}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="e.g. City of Calexico"
              />
              <p className="text-xs text-muted-foreground">
                Shown to your team across the app, on schedules you publish, and on printed
                timecards.
              </p>
            </div>
            {companyErr && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {companyErr}
              </p>
            )}
            <div className="flex justify-end">
              <Button
                onClick={() => saveCompanyName.mutate()}
                disabled={saveCompanyName.isPending || !companyNameDirty || !companyName.trim()}
              >
                {saveCompanyName.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {companySaved && <Check className="h-4 w-4" />}
                {companySaved ? "Saved" : "Save name"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {canSeeCode && company && (
        <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
          <div className="mb-3 flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            <h3 className="font-semibold text-foreground">Company join code</h3>
          </div>
          {company.status !== "active" ? (
            <p className="text-sm text-muted-foreground">
              Your company is{" "}
              <span className="font-medium text-foreground">
                {company.status.replace("_", " ")}
              </span>
              . A join code will be generated once a platform admin approves your company.
            </p>
          ) : company.join_code ? (
            <>
              <p className="text-sm text-muted-foreground mb-3">
                Share this code with employees. When they sign up with it, you'll get a join request
                to approve in the Employees page.
              </p>
              <div className="flex items-center gap-2">
                <div className="flex-1 rounded-md border border-border bg-secondary/40 px-4 py-3 text-center text-2xl font-mono font-semibold tracking-[0.3em] text-foreground">
                  {company.join_code}
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(company.join_code ?? "");
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No code yet — contact support.</p>
          )}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <div className="mb-4 flex items-center gap-2">
          <UserCog className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-foreground">Profile</h3>
        </div>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input value={user?.email ?? ""} disabled />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fn">Full name</Label>
            <Input id="fn" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="po">Position</Label>
            <Input
              id="po"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              placeholder="e.g. Shift Lead"
            />
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              Role:{" "}
              <span className="font-medium text-foreground">
                {primaryRole ? ROLE_LABEL[primaryRole] : "None"}
              </span>
            </span>
            {company && (
              <span>
                Company: <span className="font-medium text-foreground">{company.name}</span>
              </span>
            )}
          </div>
          {profileErr && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {profileErr}
            </p>
          )}
          <div className="flex justify-end">
            <Button onClick={() => saveProfile.mutate()} disabled={saveProfile.isPending}>
              {saveProfile.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {savedProfile && <Check className="h-4 w-4" />}
              {savedProfile ? "Saved" : "Save changes"}
            </Button>
          </div>
        </div>
      </div>

      <AppearanceSettings />

      <NotificationSettings />

      <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <div className="mb-4 flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-foreground">Change password</h3>
        </div>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="np">New password</Label>
            <Input
              id="np"
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="Min. 8 characters"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np2">Confirm new password</Label>
            <Input id="np2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </div>
          {pwErr && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {pwErr}
            </p>
          )}
          <div className="flex justify-end">
            <Button onClick={() => changePw.mutate()} disabled={changePw.isPending || !pw || !pw2}>
              {changePw.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {pwOk && <Check className="h-4 w-4" />}
              {pwOk ? "Updated" : "Update password"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Everyone's own notification switches — an employee's as much as an admin's.
 *
 * The master switch and the per-kind ones are saved on the account, because
 * `wants_notification()` reads the same column inside the database triggers
 * that write a notification: switched off here, the row is never created. The
 * desktop pop-up is the exception, since a browser can only grant permission
 * for itself.
 */
function NotificationSettings() {
  const { prefs, unavailable, isSaving, setEnabled, setType, setPopup, setSound, setDesktop } =
    useNotificationPrefs();
  const [permission, setPermission] = useState<string>("default");
  // Safari only offers notifications to an app that has been added to the Home
  // Screen, so "unsupported" on an iPhone is an instruction, not a dead end.
  const [needsInstall, setNeedsInstall] = useState(false);
  useEffect(() => {
    const p = desktopPermission();
    setPermission(p);
    setNeedsInstall(
      p === "unsupported" &&
        !isStandalone() &&
        /iPad|iPhone|iPod/.test(window.navigator.userAgent),
    );
  }, []);

  async function toggleDesktop(on: boolean) {
    if (!on) {
      setDesktop(false);
      return;
    }
    const result = await requestDesktopPermission();
    setPermission(result);
    // A browser that refused is not a preference we can honour, so it is not
    // one we save — the line below says why instead.
    setDesktop(result === "granted");
  }

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="mb-4 flex items-center gap-2">
        <Bell className="h-5 w-5 text-primary" />
        <h3 className="font-semibold text-foreground">Notifications</h3>
      </div>

      {unavailable && (
        <p className="mb-4 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          Your notification settings can't be saved yet — this company's database is still waiting
          on an update. Everything stays switched on until then.
        </p>
      )}

      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Notifications</p>
            <p className="text-xs text-muted-foreground">
              The master switch. Off, nothing reaches your bell and nothing pops up.
            </p>
          </div>
          <Switch
            checked={prefs.enabled}
            disabled={unavailable || isSaving}
            onCheckedChange={setEnabled}
            aria-label="All notifications"
          />
        </div>

        <div
          className={`space-y-3 ${prefs.enabled ? "" : "pointer-events-none opacity-50"}`}
          aria-disabled={!prefs.enabled}
        >
          {NOTIFICATION_TYPES.map((t) => (
            <div key={t.key} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{t.label}</p>
                <p className="text-xs text-muted-foreground">{t.detail}</p>
              </div>
              <Switch
                checked={prefs.types[t.key] !== false}
                disabled={unavailable || isSaving}
                onCheckedChange={(v) => setType(t.key, v)}
                aria-label={t.label}
              />
            </div>
          ))}

          <div className="flex items-start justify-between gap-4 border-t border-border pt-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Pop them up in the app</p>
              <p className="text-xs text-muted-foreground">
                A pop-up in the corner as it arrives, with a button to open it. Off, it only counts
                up on the bell and waits for you there.
              </p>
            </div>
            <Switch
              checked={prefs.popup}
              disabled={unavailable || isSaving}
              onCheckedChange={setPopup}
              aria-label="Pop notifications up in the app"
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Play a sound</p>
              <p className="text-xs text-muted-foreground">
                A short chime when something pops up — a new message, an announcement, your
                schedule, or your break running out.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* Hearing it is the only way to know what "a chime" means. */}
              <button
                type="button"
                onClick={() => playChime()}
                className="text-xs font-medium text-primary hover:underline"
              >
                Test
              </button>
              <Switch
                checked={prefs.sound}
                disabled={unavailable || isSaving}
                onCheckedChange={setSound}
                aria-label="Play a sound"
              />
            </div>
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Show them on this device</p>
              <p className="text-xs text-muted-foreground">
                {needsInstall
                  ? "Add Scheduling Pilot to your Home Screen first — on iPhone and iPad, notifications are only offered to the installed app."
                  : permission === "unsupported"
                    ? "This browser doesn't do system notifications."
                    : permission === "denied"
                      ? "This browser is blocking notifications — allow them in its site settings first."
                      : "A system pop-up as well as the one in the app, on your phone's lock screen too. Each device asks once."}
              </p>
            </div>
            <Switch
              checked={prefs.desktop && permission === "granted"}
              disabled={unavailable || isSaving || permission === "denied" || permission === "unsupported"}
              onCheckedChange={(v) => void toggleDesktop(v)}
              aria-label="Show notifications on this device"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Day, night, or whatever the phone is doing. Saved on this device only — see
 * `@/lib/theme` for why — so the card says so rather than letting someone
 * wonder why their laptop did not follow their phone.
 */
function AppearanceSettings() {
  const { pref, setPref } = useThemePref();
  const options: { value: ThemePref; label: string; detail: string; icon: typeof Sun }[] = [
    { value: "light", label: "Day", detail: "Light, always.", icon: Sun },
    { value: "dark", label: "Night", detail: "Dark, always.", icon: Moon },
    {
      value: "system",
      label: "Match device",
      detail: "Follows this phone or computer's own setting.",
      icon: MonitorSmartphone,
    },
  ];

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="mb-1 flex items-center gap-2">
        <Moon className="h-5 w-5 text-primary" />
        <h3 className="font-semibold text-foreground">Appearance</h3>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        Saved on this device, so your phone and your computer can each have their own.
      </p>
      <div role="radiogroup" aria-label="Appearance" className="grid gap-2 sm:grid-cols-3">
        {options.map((o) => {
          const active = pref === o.value;
          const Icon = o.icon;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPref(o.value)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                active
                  ? "border-primary bg-primary-soft/40 ring-1 ring-primary"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Icon className="h-4 w-4" />
                {o.label}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{o.detail}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
