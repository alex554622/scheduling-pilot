import type { TDocumentDefinitions, Content } from "pdfmake/interfaces";

/**
 * Real PDF generation for the timecard and the invoice.
 *
 * The screen versions of these documents are HTML, and a browser will only turn
 * HTML into a PDF through its print dialog. Since these need to download in one
 * click, the documents are described again here in pdfmake's layout language —
 * which draws real vector text, so the output is sharp at any zoom and the text
 * stays selectable and searchable, unlike the canvas-rasterising converters.
 *
 * pdfmake and its embedded fonts are ~2 MB, so this module is imported
 * dynamically and only downloads when someone actually asks for a PDF.
 */

/** Matches the ink used by the printed HTML: black on white, grey for labels. */
const INK = "#000000";
const MUTED = "#525252";
const RULE = "#d4d4d4";
const FILL = "#f5f5f5";

interface PdfMakeGlobal {
  createPdf(doc: TDocumentDefinitions): { download(filename: string): void };
  addVirtualFileSystem?(vfs: unknown): void;
}

async function createPdf(doc: TDocumentDefinitions, filename: string): Promise<void> {
  // These builds are UMD: importing pdfmake registers `window.pdfMake` rather
  // than exporting anything, and vfs_fonts then registers its font table into
  // that global on load. So they have to be awaited in order — importing both
  // in parallel can run the fonts before the global they attach to exists.
  await import("pdfmake/build/pdfmake");
  const fonts = await import("pdfmake/build/vfs_fonts");

  const pdfMake = (window as unknown as { pdfMake?: PdfMakeGlobal }).pdfMake;
  if (!pdfMake?.createPdf) throw new Error("The PDF engine failed to load. Reload the page and try again.");

  // Belt and braces: if the fonts didn't self-register, hand them over.
  const vfs = (fonts as unknown as { default?: unknown }).default;
  if (vfs && typeof pdfMake.addVirtualFileSystem === "function") pdfMake.addVirtualFileSystem(vfs);

  pdfMake.createPdf(doc).download(filename);
}

function money(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function longDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

/** A label above its value, as used across both document headers. */
function field(label: string, value: string): Content {
  return {
    stack: [
      { text: label.toUpperCase(), fontSize: 7, color: MUTED, characterSpacing: 0.6 },
      { text: value, fontSize: 10, bold: true, margin: [0, 2, 0, 0] },
    ],
  };
}

/* ------------------------------- invoice ------------------------------- */

export interface InvoicePdfData {
  number: string;
  companyName: string;
  billedTo?: string | null;
  planName: string;
  amountCents: number;
  status: string;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string;
  paidAt: string | null;
  note: string;
  issuerName?: string;
  issuerLine?: string;
}

export async function downloadInvoicePdf(data: InvoicePdfData): Promise<void> {
  const paid = data.status === "paid";
  const issuer = data.issuerName ?? "Scheduling Pilot";

  const doc: TDocumentDefinitions = {
    pageSize: "LETTER",
    pageMargins: [40, 40, 40, 40],
    defaultStyle: { fontSize: 9, color: INK, font: "Roboto" },
    content: [
      {
        columns: [
          {
            stack: [
              { text: issuer.toUpperCase(), fontSize: 14, bold: true, characterSpacing: 0.8 },
              { text: data.issuerLine ?? "Powered by Valladolid NovaTech", fontSize: 8, color: MUTED, margin: [0, 2, 0, 0] },
            ],
          },
          {
            width: "auto",
            stack: [
              { text: "INVOICE", fontSize: 20, bold: true, alignment: "right", characterSpacing: 1 },
              { text: data.number, fontSize: 11, alignment: "right", margin: [0, 2, 0, 0] },
              ...(paid
                ? [{
                    text: "PAID",
                    fontSize: 8,
                    bold: true,
                    alignment: "right" as const,
                    characterSpacing: 1.5,
                    margin: [0, 6, 0, 0] as [number, number, number, number],
                  }]
                : []),
            ],
          },
        ],
      },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.5, lineColor: INK }], margin: [0, 10, 0, 14] },

      {
        columns: [
          {
            stack: [
              { text: "BILLED TO", fontSize: 7, color: MUTED, characterSpacing: 0.6 },
              { text: data.companyName, fontSize: 12, bold: true, margin: [0, 3, 0, 0] },
              ...(data.billedTo ? [{ text: data.billedTo, fontSize: 9, color: MUTED }] : []),
            ],
          },
          {
            width: "auto",
            stack: [
              { text: `Issued: ${longDate(data.issuedAt)}`, fontSize: 9, alignment: "right" },
              ...(paid ? [{ text: `Paid: ${longDate(data.paidAt)}`, fontSize: 9, alignment: "right" as const, margin: [0, 2, 0, 0] as [number, number, number, number] }] : []),
              {
                text: `Service period: ${longDate(data.periodStart)} – ${longDate(data.periodEnd)}`,
                fontSize: 9,
                alignment: "right",
                margin: [0, 2, 0, 0],
              },
            ],
          },
        ],
        margin: [0, 0, 0, 20],
      },

      {
        table: {
          headerRows: 1,
          widths: ["*", 110],
          body: [
            [
              { text: "DESCRIPTION", fontSize: 7, bold: true, color: MUTED, characterSpacing: 0.6, fillColor: FILL, margin: [4, 5, 4, 5] },
              { text: "AMOUNT", fontSize: 7, bold: true, color: MUTED, characterSpacing: 0.6, fillColor: FILL, alignment: "right", margin: [4, 5, 4, 5] },
            ],
            [
              {
                stack: [
                  { text: `${data.planName} subscription`, bold: true },
                  { text: `${longDate(data.periodStart)} – ${longDate(data.periodEnd)}`, color: MUTED, margin: [0, 2, 0, 0] },
                ],
                margin: [4, 8, 4, 8],
              },
              { text: money(data.amountCents), alignment: "right", margin: [4, 8, 4, 8] },
            ],
          ],
        },
        layout: {
          hLineWidth: (i: number, node) => (i === 0 ? 0 : i === 1 ? 1 : i === node.table.body.length ? 1.5 : 0.5),
          hLineColor: (i: number, node) => (i === node.table.body.length ? INK : RULE),
          vLineWidth: () => 0,
          paddingLeft: () => 0,
          paddingRight: () => 0,
        },
      },

      {
        columns: [
          { text: "" },
          {
            width: "auto",
            columns: [
              { text: paid ? "TOTAL PAID" : "AMOUNT DUE", bold: true, fontSize: 9, characterSpacing: 0.5, margin: [0, 4, 12, 0] },
              { text: money(data.amountCents), bold: true, fontSize: 13, alignment: "right", width: 90 },
            ],
          },
        ],
        margin: [0, 8, 0, 0],
      },

      ...(data.note
        ? [
            { text: "NOTES", fontSize: 7, color: MUTED, characterSpacing: 0.6, margin: [0, 24, 0, 3] as [number, number, number, number] },
            { text: data.note, fontSize: 9 },
          ]
        : []),
    ],
    footer: () => ({
      margin: [40, 0, 40, 0],
      stack: [
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: RULE }] },
        {
          text: paid
            ? "This invoice has been paid in full. No further action is required."
            : "Payment is due on receipt. Your next billing date is the end of the service period shown above.",
          fontSize: 7,
          color: MUTED,
          margin: [0, 5, 0, 0],
        },
        {
          text: `${issuer} · invoice ${data.number} · generated ${new Date().toLocaleString()}`,
          fontSize: 7,
          color: MUTED,
          margin: [0, 2, 0, 0],
        },
      ],
    }),
  };

  await createPdf(doc, `${data.number}.pdf`);
}

/* ------------------------------ timecard ------------------------------ */

export interface TimecardPdfRow {
  date: string;
  clockIn: string;
  clockOut: string;
  unpaid: string;
  paid: string;
  hours: string;
  notes: string;
}

export interface TimecardPdfData {
  companyName: string;
  employeeName: string;
  position?: string | null;
  periodLabel: string;
  rangeLabel: string;
  daysWorked: number;
  rows: TimecardPdfRow[];
  totals: { unpaid: string; paid: string; worked: string; workedDecimal: string };
  regular: string;
  regularDecimal: string;
  overtime: string | null;
  overtimeDecimal: string | null;
  doubleTime: string | null;
  doubleTimeDecimal: string | null;
  /** Plain-English summary of the rules in force, printed in the footer. */
  overtimeNote: string;
  roundNote: string;
  filename: string;
}

export async function downloadTimecardPdf(data: TimecardPdfData): Promise<void> {
  const cell = (text: string, align: "left" | "center" | "right" = "center") => ({
    text,
    alignment: align,
    fontSize: 8.5,
    margin: [3, 5, 3, 5] as [number, number, number, number],
  });
  const head = (text: string, align: "left" | "center" | "right" = "center") => ({
    text: text.toUpperCase(),
    alignment: align,
    fontSize: 7,
    bold: true,
    color: MUTED,
    characterSpacing: 0.6,
    fillColor: FILL,
    margin: [3, 5, 3, 5] as [number, number, number, number],
  });

  const doc: TDocumentDefinitions = {
    pageSize: "LETTER",
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { fontSize: 9, color: INK, font: "Roboto" },
    content: [
      {
        columns: [
          {
            stack: [
              { text: data.companyName.toUpperCase(), fontSize: 14, bold: true, characterSpacing: 0.8 },
              { text: "EMPLOYEE TIMECARD", fontSize: 7, color: MUTED, characterSpacing: 1.6, margin: [0, 3, 0, 0] },
            ],
          },
          {
            width: "auto",
            stack: [
              { text: `Pay period · ${data.periodLabel}`, fontSize: 8, alignment: "right", bold: true },
              { text: data.rangeLabel, fontSize: 8, alignment: "right", color: MUTED, margin: [0, 2, 0, 0] },
            ],
          },
        ],
      },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.5, lineColor: INK }], margin: [0, 8, 0, 12] },

      {
        columns: [
          field("Employee", data.employeeName),
          field("Position", data.position || "—"),
          field("Days worked", String(data.daysWorked)),
          field("Prepared", longDate(new Date())),
        ],
        columnGap: 16,
      },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: RULE }], margin: [0, 12, 0, 12] },

      {
        table: {
          headerRows: 1,
          widths: [78, 52, 52, 58, 55, 55, "*"],
          body: [
            [head("Date", "left"), head("Clock in"), head("Clock out"), head("Unpaid break"), head("Paid break"), head("Hours", "right"), head("Notes", "left")],
            ...data.rows.map((r) => [
              { ...cell(r.date, "left"), bold: !!r.date },
              cell(r.clockIn),
              cell(r.clockOut),
              cell(r.unpaid),
              cell(r.paid),
              cell(r.hours, "right"),
              { ...cell(r.notes, "left"), color: MUTED },
            ]),
            [
              { ...cell("Period total", "left"), bold: true, fillColor: FILL },
              { ...cell(""), fillColor: FILL },
              { ...cell(""), fillColor: FILL },
              { ...cell(data.totals.unpaid), bold: true, fillColor: FILL },
              { ...cell(data.totals.paid), bold: true, fillColor: FILL },
              { ...cell(data.totals.worked, "right"), bold: true, fillColor: FILL },
              { ...cell(`${data.totals.workedDecimal} hrs`, "left"), fillColor: FILL },
            ],
          ],
        },
        layout: {
          hLineWidth: (i: number, node) =>
            i === 0 ? 0 : i === 1 ? 1 : i === node.table.body.length - 1 ? 1.5 : 0.5,
          hLineColor: (i: number, node) => (i === 1 || i === node.table.body.length - 1 ? INK : RULE),
          vLineWidth: () => 0,
          paddingLeft: () => 0,
          paddingRight: () => 0,
        },
      },

      {
        columns: [
          { text: "" },
          {
            width: 220,
            table: {
              widths: ["*", 90],
              body: [
                [{ text: "Regular hours", alignment: "right", fontSize: 8.5 }, { text: `${data.regular}  (${data.regularDecimal})`, alignment: "right", fontSize: 8.5 }],
                ...(data.overtime
                  ? [[
                      { text: "Overtime", alignment: "right" as const, fontSize: 8.5 },
                      { text: `${data.overtime}  (${data.overtimeDecimal})`, alignment: "right" as const, fontSize: 8.5 },
                    ]]
                  : []),
                ...(data.doubleTime
                  ? [[
                      { text: "Double time", alignment: "right" as const, fontSize: 8.5 },
                      { text: `${data.doubleTime}  (${data.doubleTimeDecimal})`, alignment: "right" as const, fontSize: 8.5 },
                    ]]
                  : []),
                [
                  { text: "Total worked", alignment: "right", bold: true, fontSize: 9 },
                  { text: `${data.totals.worked}  (${data.totals.workedDecimal})`, alignment: "right", bold: true, fontSize: 9 },
                ],
              ],
            },
            layout: {
              hLineWidth: (i: number, node) => (i === node.table.body.length - 1 ? 0.8 : 0),
              hLineColor: () => INK,
              vLineWidth: () => 0,
              paddingTop: () => 3,
              paddingBottom: () => 3,
              paddingRight: () => 0,
            },
          },
        ],
        margin: [0, 14, 0, 0],
      },

      {
        columns: [signatureLine("Employee signature"), signatureLine("Supervisor signature")],
        columnGap: 40,
        margin: [0, 46, 0, 0],
      },
    ],
    footer: () => ({
      margin: [40, 0, 40, 0],
      stack: [
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: RULE }] },
        {
          text: "I certify that the hours recorded above are a true and complete record of the time I worked during this pay period.",
          fontSize: 6.5,
          color: MUTED,
          margin: [0, 5, 0, 0],
        },
        { text: data.roundNote, fontSize: 6.5, color: MUTED, margin: [0, 2, 0, 0] },
        { text: data.overtimeNote, fontSize: 6.5, color: MUTED, margin: [0, 1, 0, 0] },
      ],
    }),
  };

  await createPdf(doc, data.filename);
}

function signatureLine(role: string): Content {
  return {
    stack: [
      { canvas: [{ type: "line", x1: 0, y1: 22, x2: 237, y2: 22, lineWidth: 0.8, lineColor: INK }] },
      {
        columns: [
          { text: role.toUpperCase(), fontSize: 7, color: MUTED, characterSpacing: 0.6 },
          { text: "DATE", fontSize: 7, color: MUTED, characterSpacing: 0.6, alignment: "right" },
        ],
        margin: [0, 4, 0, 0],
      },
    ],
  };
}
