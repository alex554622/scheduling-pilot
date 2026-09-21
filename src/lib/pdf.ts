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
  if (!pdfMake?.createPdf)
    throw new Error("The PDF engine failed to load. Reload the page and try again.");

  // Belt and braces: if the fonts didn't self-register, hand them over.
  const vfs = (fonts as unknown as { default?: unknown }).default;
  if (vfs && typeof pdfMake.addVirtualFileSystem === "function") pdfMake.addVirtualFileSystem(vfs);

  pdfMake.createPdf(doc).download(filename);
}

function money(cents: number): string {
  return (cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function longDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
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
              {
                text: data.issuerLine ?? "Powered by Valladolid NovaTech",
                fontSize: 8,
                color: MUTED,
                margin: [0, 2, 0, 0],
              },
            ],
          },
          {
            width: "auto",
            stack: [
              {
                text: "INVOICE",
                fontSize: 20,
                bold: true,
                alignment: "right",
                characterSpacing: 1,
              },
              { text: data.number, fontSize: 11, alignment: "right", margin: [0, 2, 0, 0] },
              ...(paid
                ? [
                    {
                      text: "PAID",
                      fontSize: 8,
                      bold: true,
                      alignment: "right" as const,
                      characterSpacing: 1.5,
                      margin: [0, 6, 0, 0] as [number, number, number, number],
                    },
                  ]
                : []),
            ],
          },
        ],
      },
      {
        canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.5, lineColor: INK }],
        margin: [0, 10, 0, 14],
      },

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
              ...(paid
                ? [
                    {
                      text: `Paid: ${longDate(data.paidAt)}`,
                      fontSize: 9,
                      alignment: "right" as const,
                      margin: [0, 2, 0, 0] as [number, number, number, number],
                    },
                  ]
                : []),
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
              {
                text: "DESCRIPTION",
                fontSize: 7,
                bold: true,
                color: MUTED,
                characterSpacing: 0.6,
                fillColor: FILL,
                margin: [4, 5, 4, 5],
              },
              {
                text: "AMOUNT",
                fontSize: 7,
                bold: true,
                color: MUTED,
                characterSpacing: 0.6,
                fillColor: FILL,
                alignment: "right",
                margin: [4, 5, 4, 5],
              },
            ],
            [
              {
                stack: [
                  { text: `${data.planName} subscription`, bold: true },
                  {
                    text: `${longDate(data.periodStart)} – ${longDate(data.periodEnd)}`,
                    color: MUTED,
                    margin: [0, 2, 0, 0],
                  },
                ],
                margin: [4, 8, 4, 8],
              },
              { text: money(data.amountCents), alignment: "right", margin: [4, 8, 4, 8] },
            ],
          ],
        },
        layout: {
          hLineWidth: (i: number, node) =>
            i === 0 ? 0 : i === 1 ? 1 : i === node.table.body.length ? 1.5 : 0.5,
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
              {
                text: paid ? "TOTAL PAID" : "AMOUNT DUE",
                bold: true,
                fontSize: 9,
                characterSpacing: 0.5,
                margin: [0, 4, 12, 0],
              },
              {
                text: money(data.amountCents),
                bold: true,
                fontSize: 13,
                alignment: "right",
                width: 90,
              },
            ],
          },
        ],
        margin: [0, 8, 0, 0],
      },

      ...(data.note
        ? [
            {
              text: "NOTES",
              fontSize: 7,
              color: MUTED,
              characterSpacing: 0.6,
              margin: [0, 24, 0, 3] as [number, number, number, number],
            },
            { text: data.note, fontSize: 9 },
          ]
        : []),
    ],
    footer: () => ({
      margin: [40, 0, 40, 0],
      stack: [
        {
          canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: RULE }],
        },
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
              {
                text: data.companyName.toUpperCase(),
                fontSize: 14,
                bold: true,
                characterSpacing: 0.8,
              },
              {
                text: "EMPLOYEE TIMECARD",
                fontSize: 7,
                color: MUTED,
                characterSpacing: 1.6,
                margin: [0, 3, 0, 0],
              },
            ],
          },
          {
            width: "auto",
            stack: [
              {
                text: `Pay period · ${data.periodLabel}`,
                fontSize: 8,
                alignment: "right",
                bold: true,
              },
              {
                text: data.rangeLabel,
                fontSize: 8,
                alignment: "right",
                color: MUTED,
                margin: [0, 2, 0, 0],
              },
            ],
          },
        ],
      },
      {
        canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.5, lineColor: INK }],
        margin: [0, 8, 0, 12],
      },

      {
        columns: [
          field("Employee", data.employeeName),
          field("Position", data.position || "—"),
          field("Days worked", String(data.daysWorked)),
          field("Prepared", longDate(new Date())),
        ],
        columnGap: 16,
      },
      {
        canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: RULE }],
        margin: [0, 12, 0, 12],
      },

      {
        table: {
          headerRows: 1,
          widths: [78, 52, 52, 58, 55, 55, "*"],
          body: [
            [
              head("Date", "left"),
              head("Clock in"),
              head("Clock out"),
              head("Unpaid break"),
              head("Paid break"),
              head("Hours", "right"),
              head("Notes", "left"),
            ],
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
          hLineColor: (i: number, node) =>
            i === 1 || i === node.table.body.length - 1 ? INK : RULE,
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
                [
                  { text: "Regular hours", alignment: "right", fontSize: 8.5 },
                  {
                    text: `${data.regular}  (${data.regularDecimal})`,
                    alignment: "right",
                    fontSize: 8.5,
                  },
                ],
                ...(data.overtime
                  ? [
                      [
                        { text: "Overtime", alignment: "right" as const, fontSize: 8.5 },
                        {
                          text: `${data.overtime}  (${data.overtimeDecimal})`,
                          alignment: "right" as const,
                          fontSize: 8.5,
                        },
                      ],
                    ]
                  : []),
                ...(data.doubleTime
                  ? [
                      [
                        { text: "Double time", alignment: "right" as const, fontSize: 8.5 },
                        {
                          text: `${data.doubleTime}  (${data.doubleTimeDecimal})`,
                          alignment: "right" as const,
                          fontSize: 8.5,
                        },
                      ],
                    ]
                  : []),
                [
                  { text: "Total worked", alignment: "right", bold: true, fontSize: 9 },
                  {
                    text: `${data.totals.worked}  (${data.totals.workedDecimal})`,
                    alignment: "right",
                    bold: true,
                    fontSize: 9,
                  },
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
        {
          canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: RULE }],
        },
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

/* ------------------------------- schedule ------------------------------- */

export interface SchedulePdfShift {
  employee: string;
  time: string;
  position: string;
  /** Matches the colour of the shift on screen. */
  colorHex: string;
  draft: boolean;
}

export interface SchedulePdfDay {
  date: string;
  shifts: SchedulePdfShift[];
}

export interface SchedulePdfData {
  companyName: string;
  rangeLabel: string;
  viewLabel: string;
  days: SchedulePdfDay[];
  totalShifts: number;
  totalHours: string;
}

/**
 * The schedule as a page to print and pin up: one row per shift, grouped by
 * day, with the colour bar from the screen carried over so a team recognises
 * its own shifts at a glance.
 */
export async function downloadSchedulePdf(data: SchedulePdfData): Promise<void> {
  const cell = (text: string, align: "left" | "center" | "right" = "left") => ({
    text,
    alignment: align,
    fontSize: 8.5,
    margin: [3, 4, 3, 4] as [number, number, number, number],
  });
  const head = (text: string, align: "left" | "center" | "right" = "left") => ({
    text: text.toUpperCase(),
    alignment: align,
    fontSize: 7,
    bold: true,
    color: MUTED,
    characterSpacing: 0.6,
    fillColor: FILL,
    margin: [3, 5, 3, 5] as [number, number, number, number],
  });

  const body: Content[][] = [
    [head(""), head("Day"), head("Employee"), head("Time"), head("Position")],
  ];

  for (const day of data.days) {
    if (day.shifts.length === 0) {
      body.push([
        { text: "" },
        { ...cell(day.date), bold: true },
        { ...cell("No shifts"), color: MUTED },
        { text: "" },
        { text: "" },
      ]);
      continue;
    }
    day.shifts.forEach((s, i) => {
      body.push([
        { text: "", fillColor: s.colorHex },
        { ...cell(i === 0 ? day.date : ""), bold: true },
        cell(s.employee),
        cell(s.time),
        { ...cell(s.draft ? `${s.position} (draft)` : s.position), color: s.draft ? MUTED : INK },
      ]);
    });
  }

  const doc: TDocumentDefinitions = {
    pageSize: "LETTER",
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { fontSize: 9, color: INK, font: "Roboto" },
    content: [
      {
        columns: [
          {
            stack: [
              {
                text: data.companyName.toUpperCase(),
                fontSize: 14,
                bold: true,
                characterSpacing: 0.8,
              },
              {
                text: "SHIFT SCHEDULE",
                fontSize: 7,
                color: MUTED,
                characterSpacing: 1.6,
                margin: [0, 3, 0, 0],
              },
            ],
          },
          {
            width: "auto",
            stack: [
              { text: data.viewLabel, fontSize: 8, alignment: "right", bold: true },
              {
                text: data.rangeLabel,
                fontSize: 8,
                alignment: "right",
                color: MUTED,
                margin: [0, 2, 0, 0],
              },
            ],
          },
        ],
      },
      {
        canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.5, lineColor: INK }],
        margin: [0, 8, 0, 12],
      },
      {
        columns: [
          field("Shifts", String(data.totalShifts)),
          field("Scheduled hours", data.totalHours),
          field("Prepared", longDate(new Date())),
        ],
        columnGap: 16,
      },
      {
        canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: RULE }],
        margin: [0, 12, 0, 12],
      },
      {
        table: { headerRows: 1, widths: [6, 80, 130, 96, "*"], body },
        layout: {
          hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
            i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.4,
          vLineWidth: () => 0,
          hLineColor: () => RULE,
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
      },
    ],
    footer: (current: number, total: number) => ({
      columns: [
        { text: data.companyName, fontSize: 7, color: MUTED, margin: [40, 0, 0, 0] },
        {
          text: `Page ${current} of ${total}`,
          fontSize: 7,
          color: MUTED,
          alignment: "right",
          margin: [0, 0, 40, 0],
        },
      ],
      margin: [0, 16, 0, 0],
    }),
  };

  const safeRange = data.rangeLabel.replace(/[^\w\s–-]+/g, "").trim();
  await createPdf(doc, `Schedule ${safeRange}.pdf`);
}

/* ---------------------------- schedule sheet ---------------------------- */

export interface SheetDay {
  day: number;
  /** Two-letter weekday, as printed above the column: MO, TU, WE… */
  weekday: string;
}

export interface SheetRow {
  name: string;
  /** One entry per day of the month: worked or not. */
  marks: boolean[];
}

export interface SheetGroup {
  name: string;
  hours: string;
  rows: SheetRow[];
}

export interface ScheduleSheetPdfData {
  title: string;
  subtitle: string;
  revised: string;
  monthLabel: string;
  days: SheetDay[];
  groups: SheetGroup[];
}

/**
 * The month on one landscape page, laid out the way a posted duty roster is
 * read: a column per day, teams as banded sections, an X on every day worked.
 */
export async function downloadScheduleSheetPdf(data: ScheduleSheetPdfData): Promise<void> {
  const dayCount = data.days.length;
  const nameWidth = 116;
  // Content is a union that includes arrays, so the overrides are typed as a
  // plain bag of properties rather than Partial<Content>, which cannot spread.
  const cell = (text: string, opts: Record<string, unknown> = {}) => ({
    text,
    alignment: "center" as const,
    fontSize: 7.5,
    margin: [0, 3, 0, 3] as [number, number, number, number],
    ...opts,
  });

  const body: Content[][] = [
    [
      {
        text: data.monthLabel.toUpperCase(),
        bold: true,
        fontSize: 8,
        fillColor: FILL,
        margin: [4, 4, 4, 4],
      },
      ...data.days.map((d) =>
        cell(String(d.day), { bold: true, fillColor: FILL, margin: [0, 4, 0, 4] }),
      ),
    ],
    [
      { text: "", fillColor: FILL, margin: [4, 2, 4, 2] },
      ...data.days.map((d) =>
        cell(d.weekday, { fontSize: 6.5, color: MUTED, fillColor: FILL, margin: [0, 2, 0, 2] }),
      ),
    ],
  ];

  for (const group of data.groups) {
    body.push([
      {
        text: `${group.name}    ${group.hours}`,
        bold: true,
        fontSize: 7.5,
        fillColor: "#e5e5e5",
        margin: [4, 3, 4, 3],
      },
      ...data.days.map(() => ({ text: "", fillColor: "#e5e5e5" })),
    ]);
    for (const row of group.rows) {
      body.push([
        { text: row.name, fontSize: 7.5, margin: [4, 3, 4, 3] },
        ...data.days.map((_, i) => cell(row.marks[i] ? "X" : "", { bold: row.marks[i] })),
      ]);
    }
    if (group.rows.length === 0) {
      body.push([
        { text: "—", fontSize: 7.5, color: MUTED, margin: [4, 3, 4, 3] },
        ...data.days.map(() => cell("")),
      ]);
    }
  }

  const doc: TDocumentDefinitions = {
    pageSize: "LETTER",
    pageOrientation: "landscape",
    pageMargins: [28, 30, 28, 34],
    defaultStyle: { fontSize: 8, color: INK, font: "Roboto" },
    content: [
      {
        text: data.title.toUpperCase(),
        fontSize: 13,
        bold: true,
        alignment: "center",
        characterSpacing: 0.6,
      },
      {
        columns: [
          { text: data.subtitle, fontSize: 8, color: MUTED },
          {
            text: data.revised ? `revised ${data.revised}` : "",
            fontSize: 8,
            color: MUTED,
            alignment: "right",
          },
        ],
        margin: [0, 4, 0, 8],
      },
      {
        table: {
          headerRows: 2,
          widths: [nameWidth, ...Array.from({ length: dayCount }, () => "*" as const)],
          body,
        },
        layout: {
          hLineWidth: () => 0.4,
          vLineWidth: () => 0.4,
          hLineColor: () => RULE,
          vLineColor: () => RULE,
          paddingLeft: () => 1,
          paddingRight: () => 1,
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
      },
    ],
    footer: (current: number, total: number) => ({
      columns: [
        { text: data.title, fontSize: 7, color: MUTED, margin: [28, 0, 0, 0] },
        {
          text: `Page ${current} of ${total}`,
          fontSize: 7,
          color: MUTED,
          alignment: "right",
          margin: [0, 0, 28, 0],
        },
      ],
      margin: [0, 10, 0, 0],
    }),
  };

  await createPdf(doc, `${data.monthLabel.replace(/[^\w\s-]+/g, "").trim()} schedule.pdf`);
}

function signatureLine(role: string): Content {
  return {
    stack: [
      {
        canvas: [{ type: "line", x1: 0, y1: 22, x2: 237, y2: 22, lineWidth: 0.8, lineColor: INK }],
      },
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

/* --------------------------- weekly grid sheet --------------------------- */

export interface GridPdfShift {
  time: string;
  position: string;
  colorHex: string;
  draft: boolean;
}

export interface GridPdfWeek {
  /** "September 14, 2026 – September 20, 2026" */
  rangeLabel: string;
  /** Seven columns: "Monday" over "09/14/2026". */
  days: { name: string; date: string }[];
  /** One row per person who works that week; `cells` has seven entries. */
  rows: { name: string; cells: GridPdfShift[][] }[];
}

export interface GridPdfData {
  companyName: string;
  weeks: GridPdfWeek[];
  legend: { label: string; colorHex: string }[];
}

/** The colour washed toward white, so a cell is tinted rather than flooded. */
function wash(hex: string, strength = 0.2): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#eef2ff";
  const n = parseInt(m[1], 16);
  const mix = (c: number) => Math.round(255 - (255 - c) * strength);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/**
 * The posted sheet: the week across the top, everyone down the side, each
 * shift in its day with its time and its post. The format a department pins to
 * the wall, laid out the way the one it replaces was — then cleaned up.
 *
 * Each shift is a tinted tab with a solid bar of its colour down the left edge,
 * the printed echo of the glass chips on screen: light enough to write on and
 * cheap on ink, where a flooded yellow cell is neither. The header row repeats
 * on every page, one week to a page, with a legend for the colours at the foot.
 */
export async function downloadScheduleGridPdf(data: GridPdfData): Promise<void> {
  const HEADER = "#1e293b";
  const LINE = "#e2e8f0";
  const printed = longDate(new Date());

  const content: Content[] = [];

  data.weeks.forEach((week, wi) => {
    const head: Content[] = [
      {
        text: "TEAM",
        fontSize: 7,
        bold: true,
        color: "#cbd5e1",
        characterSpacing: 0.8,
        fillColor: HEADER,
        margin: [4, 8, 4, 8],
      },
      ...week.days.map(
        (d): Content => ({
          stack: [
            { text: d.name, fontSize: 9.5, bold: true, color: "#ffffff" },
            { text: d.date, fontSize: 7.5, color: "#cbd5e1", margin: [0, 1, 0, 0] },
          ],
          alignment: "center",
          fillColor: HEADER,
          margin: [2, 5, 2, 5],
        }),
      ),
    ];

    const body: Content[][] = [head];
    week.rows.forEach((row, ri) => {
      const zebra = ri % 2 ? "#f8fafc" : "#ffffff";
      body.push([
        { text: row.name, fontSize: 9, bold: true, fillColor: zebra, margin: [4, 6, 4, 6] },
        ...row.cells.map(
          // No fill on the day cells themselves: pdfmake paints a cell fill over
          // anything drawn inside it, and a zebra stripe here wiped out every
          // coloured tab. The stripe stays on the name column, which is enough
          // to follow a row across.
          (cell): Content => ({
            margin: [2, 3, 2, 1],
            stack: cell.map(
              (s): Content => ({
                // A two-column table is the only way pdfmake draws a coloured
                // edge on one side: a thin column of solid colour, then the tint.
                table: {
                  widths: [2, "*"],
                  body: [
                    [
                      { text: "", fillColor: s.colorHex },
                      {
                        fillColor: wash(s.colorHex),
                        margin: [4, 3, 3, 3],
                        stack: [
                          {
                            text: s.time,
                            fontSize: 8,
                            bold: true,
                            italics: s.draft,
                            color: "#0f172a",
                          },
                          ...(s.position || s.draft
                            ? [
                                {
                                  text: `${s.position}${s.draft ? `${s.position ? " · " : ""}DRAFT` : ""}`,
                                  fontSize: 6.8,
                                  color: "#475569",
                                  margin: [0, 1, 0, 0] as [number, number, number, number],
                                },
                              ]
                            : []),
                        ],
                      },
                    ],
                  ],
                },
                layout: "noBorders",
                margin: [0, 0, 0, 2],
              }),
            ),
          }),
        ),
      ]);
    });

    content.push(
      {
        columns: [
          {
            stack: [
              {
                text: "WEEKLY SCHEDULE",
                fontSize: 7,
                bold: true,
                color: MUTED,
                characterSpacing: 1,
              },
              { text: week.rangeLabel, fontSize: 15, bold: true, margin: [0, 2, 0, 0] },
            ],
          },
          {
            stack: [
              { text: data.companyName, fontSize: 11, bold: true, alignment: "right" },
              {
                text: `Printed ${printed}`,
                fontSize: 7.5,
                color: MUTED,
                alignment: "right",
                margin: [0, 2, 0, 0],
              },
            ],
          },
        ],
        margin: [0, 0, 0, 10],
        ...(wi > 0 ? { pageBreak: "before" as const } : {}),
      },
      week.rows.length === 0
        ? { text: "Nobody is scheduled this week.", color: MUTED, fontSize: 10, margin: [0, 20, 0, 0] }
        : {
            table: {
              headerRows: 1,
              dontBreakRows: true,
              widths: [88, "*", "*", "*", "*", "*", "*", "*"],
              body,
            },
            layout: {
              hLineColor: () => LINE,
              vLineColor: () => LINE,
              hLineWidth: () => 0.6,
              vLineWidth: () => 0.6,
              paddingLeft: () => 0,
              paddingRight: () => 0,
              paddingTop: () => 0,
              paddingBottom: () => 0,
            },
          },
    );
  });

  if (data.legend.length) {
    content.push({
      margin: [0, 12, 0, 0],
      columns: [
        {
          width: "auto",
          text: "KEY",
          fontSize: 7,
          bold: true,
          color: MUTED,
          characterSpacing: 0.8,
          margin: [0, 1, 8, 0],
        },
        // A nested column set is a legal column, but pdfmake's types only let
        // `width` sit on the leaf kinds — hence the cast.
        ...data.legend.map(
          (l) =>
            ({
              width: "auto",
              margin: [0, 0, 14, 0],
              columns: [
                {
                  width: 8,
                  canvas: [{ type: "rect", x: 0, y: 1, w: 8, h: 8, r: 1.5, color: l.colorHex }],
                },
                { width: "auto", text: l.label, fontSize: 8, margin: [4, 0, 0, 0] },
              ],
            }) as unknown as Content,
        ),
      ],
    });
  }

  const doc: TDocumentDefinitions = {
    pageSize: "LETTER",
    pageOrientation: "landscape",
    pageMargins: [30, 30, 30, 36],
    defaultStyle: { fontSize: 9, color: INK },
    footer: (page, pages) => ({
      margin: [30, 10, 30, 0],
      columns: [
        { text: data.companyName, fontSize: 7, color: MUTED },
        { text: `Page ${page} of ${pages}`, fontSize: 7, color: MUTED, alignment: "right" },
      ],
    }),
    content,
  };

  const first = data.weeks[0]?.days[0]?.date.replace(/\//g, "-") ?? "week";
  await createPdf(doc, `schedule-grid-${first}.pdf`);
}
