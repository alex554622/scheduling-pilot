/**
 * The paper version of an invoice — the document a company files, not a screen.
 * Hidden on screen via `[data-print-only]` (see styles.css) and laid out for
 * letter portrait in black and white.
 */

export interface InvoiceRecord {
  id: string;
  number: string;
  plan_name: string;
  amount_cents: number;
  status: string;
  period_start: string | null;
  period_end: string | null;
  issued_at: string;
  paid_at: string | null;
  note: string;
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function fmtAmount(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function PrintableInvoice({
  invoice,
  companyName,
  billedTo,
  issuerName = "Scheduling Pilot",
  issuerLine = "Powered by Valladolid NovaTech",
}: {
  invoice: InvoiceRecord;
  companyName: string;
  billedTo?: string | null;
  issuerName?: string;
  issuerLine?: string;
}) {
  const paid = invoice.status === "paid";

  return (
    <div data-print-only className="mx-auto max-w-[7.5in] bg-white font-sans text-[11px] leading-snug text-black">
      <header className="flex items-start justify-between border-b-2 border-black pb-3">
        <div>
          <p className="text-[15px] font-bold uppercase tracking-wide">{issuerName}</p>
          <p className="mt-0.5 text-[10px] text-neutral-600">{issuerLine}</p>
        </div>
        <div className="text-right">
          <p className="text-[20px] font-bold uppercase tracking-wide">Invoice</p>
          <p className="font-mono text-[12px]">{invoice.number}</p>
          {paid && (
            <p className="mt-1 inline-block border border-black px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest">
              Paid
            </p>
          )}
        </div>
      </header>

      <section className="mt-4 grid grid-cols-2 gap-8">
        <div>
          <p className="text-[9px] uppercase tracking-wider text-neutral-500">Billed to</p>
          <p className="mt-0.5 text-[13px] font-semibold">{companyName}</p>
          {billedTo && <p className="text-neutral-700">{billedTo}</p>}
        </div>
        <div className="text-right">
          <Row label="Issued" value={fmtDate(invoice.issued_at)} />
          {paid && <Row label="Paid" value={fmtDate(invoice.paid_at)} />}
          <Row
            label="Service period"
            value={`${fmtDate(invoice.period_start)} – ${fmtDate(invoice.period_end)}`}
          />
        </div>
      </section>

      <table className="mt-6 w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-neutral-100">
            <th className="border-b border-black px-2 py-1.5 text-left text-[9px] font-semibold uppercase tracking-wider">
              Description
            </th>
            <th className="w-40 border-b border-black px-2 py-1.5 text-right text-[9px] font-semibold uppercase tracking-wider">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-neutral-300">
            <td className="px-2 py-2.5 align-top">
              <p className="font-medium">{invoice.plan_name} subscription</p>
              <p className="text-neutral-600">
                {fmtDate(invoice.period_start)} – {fmtDate(invoice.period_end)}
              </p>
            </td>
            <td className="px-2 py-2.5 text-right align-top tabular-nums">{fmtAmount(invoice.amount_cents)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-black">
            <td className="px-2 py-2 text-right font-semibold uppercase tracking-wide">
              {paid ? "Total paid" : "Amount due"}
            </td>
            <td className="px-2 py-2 text-right text-[14px] font-bold tabular-nums">
              {fmtAmount(invoice.amount_cents)}
            </td>
          </tr>
        </tfoot>
      </table>

      {invoice.note && (
        <section className="mt-5" data-print-keep>
          <p className="text-[9px] uppercase tracking-wider text-neutral-500">Notes</p>
          <p className="mt-0.5 whitespace-pre-wrap">{invoice.note}</p>
        </section>
      )}

      <footer className="mt-10 border-t border-neutral-300 pt-2 text-[9px] text-neutral-500">
        <p>
          {paid
            ? "This invoice has been paid in full. No further action is required."
            : "Payment is due on receipt. Your next billing date is the end of the service period shown above."}
        </p>
        <p className="mt-1">
          {issuerName} · invoice {invoice.number} · generated {new Date().toLocaleString()}
        </p>
      </footer>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <p className="mt-0.5">
      <span className="text-[9px] uppercase tracking-wider text-neutral-500">{label}: </span>
      <span className="font-medium">{value}</span>
    </p>
  );
}
