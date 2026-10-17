import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Ban, CalendarPlus, Check, Copy, Download as DownloadIcon, Loader2, Pencil, Printer, Receipt,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { PrintableInvoice, type InvoiceRecord } from "@/components/printable-invoice";
import { useT, localeTag } from "@/lib/i18n";
import { billingDueLabel, fmtBillingDate, isBillingOverdue, toLocalDateTimeInput } from "@/lib/billing";

export type BillingAction = "paid" | "extend" | "suspend" | "date";

export interface BillingTarget {
  companyId: string;
  companyName: string;
  companyStatus: string;
  subStatus: string;
  planName: string;
  amountCents: number;
  periodEnd: string | null;
  adminEmail: string | null;
}

/**
 * Everything about one company's billing, for its detail page: the date, how
 * close it is, and the four things a super admin can do — take payment, extend,
 * change the date outright, or suspend.
 */
export function CompanyBillingSection({ target }: { target: BillingTarget }) {
  const t = useT("admin");
  const qc = useQueryClient();
  const [action, setAction] = useState<BillingAction | null>(null);
  const [invoice, setInvoice] = useState<InvoiceRecord | null>(null);
  const overdue = isBillingOverdue(target);

  function refresh() {
    for (const key of [
      "companies-admin", "companies-subs", "companies-headcount",
      "platform-companies", "platform-subs", "billing-overview",
    ]) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Receipt className="h-4 w-4 text-primary" />{t("Billing & renewals")}
      </h3>

      <div
        className={`rounded-lg border p-3 ${overdue ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/30"}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("Billing date")}</p>
            <p className="text-lg font-semibold text-foreground">{fmtBillingDate(target.periodEnd)}</p>
            <p className={`text-xs ${overdue ? "font-medium text-destructive" : "text-muted-foreground"}`}>
              {overdue && <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-text-bottom" />}
              {billingDueLabel(target.periodEnd)}
              {target.planName !== "—" && ` · ${target.planName}`}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setAction("date")}>
            <Pencil className="mr-1.5 h-3.5 w-3.5" />{t("Edit date")}
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-3">
          <Button size="sm" onClick={() => setAction("paid")}>
            <Check className="mr-1.5 h-3.5 w-3.5" />{t("Mark paid")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAction("extend")}>
            <CalendarPlus className="mr-1.5 h-3.5 w-3.5" />{t("Extend free")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={target.companyStatus === "suspended"}
            onClick={() => setAction("suspend")}
          >
            <Ban className="mr-1.5 h-3.5 w-3.5" />{t("Suspend")}
          </Button>
        </div>
      </div>

      {action && (
        <BillingActionDialog
          target={target}
          action={action}
          onClose={() => setAction(null)}
          onDone={(inv) => {
            setAction(null);
            refresh();
            if (inv) setInvoice(inv);
          }}
        />
      )}

      {invoice && <InvoiceDialog invoice={invoice} target={target} onClose={() => setInvoice(null)} />}
    </div>
  );
}

export function BillingActionDialog({
  target, action, onClose, onDone,
}: {
  target: BillingTarget;
  action: BillingAction;
  onClose: () => void;
  onDone: (invoice: InvoiceRecord | null) => void;
}) {
  const t = useT("admin");
  const [months, setMonths] = useState("1");
  const [days, setDays] = useState("14");
  const [date, setDate] = useState(() => toLocalDateTimeInput(target.periodEnd ?? new Date()));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      if (action === "paid") {
        const { data, error } = await supabase.rpc("mark_subscription_paid", {
          _company: target.companyId,
          _months: Math.max(1, Math.round(Number(months) || 1)),
          _note: note.trim(),
        });
        if (error) throw error;
        return data as unknown as InvoiceRecord;
      }
      if (action === "extend") {
        const { error } = await supabase.rpc("extend_subscription", {
          _company: target.companyId,
          _days: Math.max(1, Math.round(Number(days) || 1)),
          _reason: note.trim(),
        });
        if (error) throw error;
        return null;
      }
      if (action === "date") {
        const { error } = await supabase.rpc("set_billing_date", {
          _company: target.companyId,
          _date: new Date(date).toISOString(),
          _reason: note.trim(),
        });
        if (error) throw error;
        return null;
      }
      const { error } = await supabase.rpc("suspend_company_for_nonpayment", {
        _company: target.companyId,
        _reason: note.trim(),
      });
      if (error) throw error;
      return null;
    },
    onSuccess: (inv) => onDone(inv),
    onError: (e: Error) => setError(e.message),
  });

  const copy = {
    paid: {
      title: t("Record a payment"),
      body: t("Rolls {company}'s billing period forward and issues a paid invoice. The billing day of the month stays the same.", { company: target.companyName }),
      cta: t("Mark paid & create invoice"),
    },
    extend: {
      title: t("Extend for free"),
      body: t("Gives {company} more time at no charge. An extension on a lapsed account runs from today, not from the old date.", { company: target.companyName }),
      cta: t("Extend"),
    },
    date: {
      title: t("Edit the billing date"),
      body: t("Sets {company}'s next billing date directly. Use this for a date agreed off-platform, or to correct one that's wrong.", { company: target.companyName }),
      cta: t("Save billing date"),
    },
    suspend: {
      title: t("Suspend for non-payment"),
      body: t("Locks everyone at {company} out until the account is paid or reactivated. Recorded in the audit log.", { company: target.companyName }),
      cta: t("Suspend account"),
    },
  }[action];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {action === "paid" && (
            <div className="space-y-1.5">
              <Label htmlFor="bill-months">{t("Periods paid (months)")}</Label>
              <Input id="bill-months" type="number" min={1} max={36} value={months}
                onChange={(e) => setMonths(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                {t("Invoice total: {amount}", { amount: ((target.amountCents * Math.max(1, Number(months) || 1)) / 100).toFixed(2) })}
              </p>
            </div>
          )}

          {action === "extend" && (
            <div className="space-y-1.5">
              <Label htmlFor="bill-days">{t("Extra days")}</Label>
              <Input id="bill-days" type="number" min={1} max={365} value={days}
                onChange={(e) => setDays(e.target.value)} />
            </div>
          )}

          {action === "date" && (
            <div className="space-y-1.5">
              <Label htmlFor="bill-date">{t("Next billing date")}</Label>
              <Input id="bill-date" type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                {t("A date in the past leaves the account overdue; it won't be marked active.")}
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="bill-note">{action === "paid" ? t("Note on the invoice") : t("Reason")}</Label>
            <Input id="bill-note" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder={action === "paid" ? t("e.g. Paid by bank transfer") : t("e.g. Agreed new date with the client")} />
          </div>

          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel")}</Button>
          <Button
            variant={action === "suspend" ? "destructive" : "default"}
            disabled={run.isPending}
            onClick={() => { setError(null); run.mutate(); }}
          >
            {run.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {copy.cta}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InvoiceDialog({
  invoice, target, onClose,
}: {
  invoice: InvoiceRecord;
  target: BillingTarget;
  onClose: () => void;
}) {
  const t = useT("admin");
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const markSent = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("mark_invoice_sent", {
        _invoice: invoice.id,
        _to: target.adminEmail ?? "",
      });
      if (error) throw error;
    },
    onSuccess: () => setSent(true),
    onError: (e: Error) => setError(e.message),
  });

  return (
    <>
      {/* Outside the dialog so printing captures the document, not the modal —
          Dialog itself is marked data-print-hide. */}
      <PrintableInvoice invoice={invoice} companyName={target.companyName} billedTo={target.adminEmail} />

      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Invoice {number}", { number: invoice.number })}</DialogTitle>
            <DialogDescription>
              {target.companyName} · {invoice.plan_name} · {(invoice.amount_cents / 100).toFixed(2)}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1 text-sm">
            <p className="text-muted-foreground">
              {t("Service period {start} – {end}. That end date is now their next billing date.", {
                start: new Date(invoice.period_start ?? "").toLocaleDateString(localeTag()),
                end: new Date(invoice.period_end ?? "").toLocaleDateString(localeTag()),
              })}
            </p>

            <div className="rounded-lg border border-border bg-secondary/40 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("Download it, then email it to")}
              </p>
              <div className="mt-1 flex items-center justify-between gap-2">
                <p className="min-w-0 truncate font-medium text-foreground">
                  {target.adminEmail ?? t("No admin email on file")}
                </p>
                {target.adminEmail && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 px-2"
                    onClick={() => {
                      void navigator.clipboard.writeText(target.adminEmail!);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    <span className="ml-1.5">{copied ? t("Copied") : t("Copy")}</span>
                  </Button>
                )}
              </div>
            </div>

            {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter className="flex-wrap gap-2">
            <div className="mr-auto flex gap-2">
              <Button variant="outline" onClick={() => window.print()} title={t("Send to a printer, or choose “Save as PDF”")}>
                <Printer className="mr-2 h-4 w-4" />{t("Print")}
              </Button>
              <Button
                title={t("Saves a PDF straight to your downloads")}
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  setError(null);
                  try {
                    const { downloadInvoicePdf } = await import("@/lib/pdf");
                    await downloadInvoicePdf({
                      number: invoice.number,
                      companyName: target.companyName,
                      billedTo: target.adminEmail,
                      planName: invoice.plan_name,
                      amountCents: invoice.amount_cents,
                      status: invoice.status,
                      periodStart: invoice.period_start,
                      periodEnd: invoice.period_end,
                      issuedAt: invoice.issued_at,
                      paidAt: invoice.paid_at,
                      note: invoice.note,
                    });
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <DownloadIcon className="mr-2 h-4 w-4" />}
                {t("Download PDF")}
              </Button>
            </div>
            <Button
              variant="outline"
              disabled={!target.adminEmail || markSent.isPending || sent}
              onClick={() => { setError(null); markSent.mutate(); }}
            >
              {markSent.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {sent ? t("Marked as sent") : t("I've sent it")}
            </Button>
            <Button variant="ghost" onClick={onClose}>{t("Close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
