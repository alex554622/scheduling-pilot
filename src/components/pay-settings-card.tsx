import { useEffect, useState } from "react";
import { Wallet, Check, ChevronDown, EyeOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clearPaySettings, writePaySettings, type PaySettings } from "@/lib/pay-settings";

/**
 * Where the employee sets the rate that drives the live earnings readout.
 * `settings` is owned by the page so the two stay in step without a round trip
 * through storage on every keystroke.
 */
export function PaySettingsCard({
  userId,
  settings,
  onChange,
}: {
  userId: string;
  settings: PaySettings | null;
  onChange: (next: PaySettings | null) => void;
}) {
  const [rate, setRate] = useState("");
  const [tax, setTax] = useState("");
  const [state, setState] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Folded away by default: most days nobody is changing their pay rate, and
  // an open form of money fields is not something to leave on a shared screen.
  const [open, setOpen] = useState(false);

  // Seed the fields from storage once it has been read, and whenever the saved
  // values change from elsewhere (a reset, say).
  useEffect(() => {
    setRate(settings ? String(settings.hourlyRate) : "");
    setTax(settings ? String(settings.taxPercent) : "");
    setState(settings ? String(settings.statePercent) : "");
  }, [settings]);

  function save(e: React.FormEvent) {
    e.preventDefault();
    const hourlyRate = Number(rate);
    const taxPercent = tax.trim() === "" ? 0 : Number(tax);
    const statePercent = state.trim() === "" ? 0 : Number(state);
    if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
      setError("Enter your hourly pay as a number greater than zero.");
      return;
    }
    for (const [label, value] of [
      ["Federal tax", taxPercent],
      ["State tax", statePercent],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        setError(`${label} must be between 0 and 100 percent.`);
        return;
      }
    }
    if (taxPercent + statePercent > 100) {
      setError("Federal and state tax add up to more than 100% — take-home would be negative.");
      return;
    }
    const next: PaySettings = { hourlyRate, taxPercent, statePercent };
    writePaySettings(userId, next);
    onChange(next);
    setError(null);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function reset() {
    clearPaySettings(userId);
    onChange(null);
    setError(null);
  }

  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Wallet className="h-4 w-4 text-primary" /> My pay
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {settings ? `${settings.hourlyRate}/hr` : "Not set"}
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>

      {open && (
        <div className="border-t border-border p-5">
          <p className="mb-4 flex items-start gap-1.5 text-xs text-muted-foreground">
            <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Only you can see this. It is stored on this device and never sent to your company.
          </p>

          <form className="space-y-3" onSubmit={save}>
            <div className="space-y-1.5">
              <Label htmlFor="hourly-rate">Hourly pay</Label>
              <Input
                id="hourly-rate"
                inputMode="decimal"
                placeholder="0.00"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="tax-percent">Federal tax %</Label>
                <Input
                  id="tax-percent"
                  inputMode="decimal"
                  placeholder="0"
                  value={tax}
                  onChange={(e) => setTax(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="state-percent">State tax %</Label>
                <Input
                  id="state-percent"
                  inputMode="decimal"
                  placeholder="0"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                />
              </div>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex items-center gap-2">
              <Button type="submit" size="sm">
                {saved ? (
                  <>
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                    Saved
                  </>
                ) : (
                  "Save"
                )}
              </Button>
              {settings && (
                <Button type="button" size="sm" variant="ghost" onClick={reset}>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Clear
                </Button>
              )}
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
