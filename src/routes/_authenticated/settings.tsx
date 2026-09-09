import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, ROLE_LABEL } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Check, KeyRound, UserCog, Building2, Copy } from "lucide-react";

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
    onSuccess: () => { setSavedProfile(true); setProfileErr(null); setTimeout(() => setSavedProfile(false), 1500); },
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
    onSuccess: () => { setPw(""); setPw2(""); setPwErr(null); setPwOk(true); setTimeout(() => setPwOk(false), 2000); },
    onError: (e: unknown) => setPwErr(e instanceof Error ? e.message : String(e)),
  });

  const canSeeCode = primaryRole === "company_admin" || primaryRole === "super_admin";
  const [copied, setCopied] = useState(false);

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Settings</h2>
        <p className="text-sm text-muted-foreground">Manage your profile and password.</p>
      </div>

      {canSeeCode && company && (
        <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
          <div className="mb-3 flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            <h3 className="font-semibold text-foreground">Company join code</h3>
          </div>
          {company.status !== "active" ? (
            <p className="text-sm text-muted-foreground">
              Your company is <span className="font-medium text-foreground">{company.status.replace("_", " ")}</span>. A join code will be generated once a platform admin approves your company.
            </p>
          ) : company.join_code ? (
            <>
              <p className="text-sm text-muted-foreground mb-3">
                Share this code with employees. When they sign up with it, you'll get a join request to approve in the Employees page.
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
            <Input id="po" value={position} onChange={(e) => setPosition(e.target.value)} placeholder="e.g. Shift Lead" />
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>Role: <span className="font-medium text-foreground">{primaryRole ? ROLE_LABEL[primaryRole] : "None"}</span></span>
            {company && <span>Company: <span className="font-medium text-foreground">{company.name}</span></span>}
          </div>
          {profileErr && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{profileErr}</p>}
          <div className="flex justify-end">
            <Button onClick={() => saveProfile.mutate()} disabled={saveProfile.isPending}>
              {saveProfile.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {savedProfile && <Check className="h-4 w-4" />}
              {savedProfile ? "Saved" : "Save changes"}
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <div className="mb-4 flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-foreground">Change password</h3>
        </div>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="np">New password</Label>
            <Input id="np" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Min. 8 characters" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np2">Confirm new password</Label>
            <Input id="np2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </div>
          {pwErr && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{pwErr}</p>}
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
