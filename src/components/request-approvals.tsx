import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Check, X, Loader2, Clock } from "lucide-react";
import { localeTag, useT } from "@/lib/i18n";

/**
 * The approval chain shared by time off and shift trades: every supervisor of
 * the people in a request approves, then a company admin gives the final
 * answer. The database decides all of it — who must approve, whether a step
 * is done, who may act — in 20261128120000_request_approval_chain.sql. This
 * file only reads the decisions and sends the buttons' answers.
 */

export type RequestType = "time_off" | "shift_trade";

export interface Approval {
  id: string;
  request_id: string;
  approver_id: string;
  stage: "supervisor" | "admin";
  decision: "approved" | "denied" | null;
  comment: string | null;
  decided_at: string | null;
}

/** Every decision this viewer may see on these requests, grouped by request. */
export function useRequestApprovals(type: RequestType, companyId: string | null) {
  return useQuery({
    queryKey: ["request-approvals", type, companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("request_approvals")
        .select("id, request_id, approver_id, stage, decision, comment, decided_at")
        .eq("request_type", type)
        .eq("company_id", companyId!)
        .order("created_at");
      if (error) throw error;
      const byRequest = new Map<string, Approval[]>();
      for (const a of (data ?? []) as Approval[]) {
        const list = byRequest.get(a.request_id) ?? [];
        list.push(a);
        byRequest.set(a.request_id, list);
      }
      return byRequest;
    },
  });
}

/** Whether `userId` is a supervisor on this request who still has to answer. */
export function awaitsMe(approvals: Approval[] | undefined, userId: string | undefined) {
  return !!approvals?.some(
    (a) => a.stage === "supervisor" && a.approver_id === userId && a.decision === null,
  );
}

function fmtWhen(iso: string) {
  const d = new Date(iso);
  const tag = localeTag();
  return `${d.toLocaleDateString(tag, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(tag, { hour: "numeric", minute: "2-digit" })}`;
}

/**
 * Who has answered and who is still to. Supervisor rows first, then the admin.
 */
export function ApprovalTrail({
  approvals,
  nameOf,
  pending,
}: {
  approvals: Approval[] | undefined;
  nameOf: (id: string) => string;
  /** Whether the request is still open; a closed one doesn't list who never answered. */
  pending: boolean;
}) {
  const t = useT("time");
  const rows = (approvals ?? []).filter((a) => pending || a.decision !== null);
  if (rows.length === 0) return null;
  const ordered = [...rows].sort((a, b) =>
    a.stage === b.stage ? 0 : a.stage === "supervisor" ? -1 : 1,
  );
  return (
    <ul className="mt-1.5 space-y-0.5">
      {ordered.map((a) => (
        <li
          key={a.id}
          className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground"
        >
          {a.decision === "approved" ? (
            <Check className="h-3 w-3 self-center text-success" />
          ) : a.decision === "denied" ? (
            <X className="h-3 w-3 self-center text-destructive" />
          ) : (
            <Clock className="h-3 w-3 self-center" />
          )}
          <span className="font-medium text-foreground">{nameOf(a.approver_id)}</span>
          <span>({a.stage === "admin" ? t("Admin") : t("Supervisor")})</span>
          <span>
            {a.decision === "approved"
              ? t("approved")
              : a.decision === "denied"
                ? t("denied")
                : t("waiting")}
          </span>
          {a.decided_at && <span>· {fmtWhen(a.decided_at)}</span>}
          {a.comment && <span className="italic">· "{a.comment}"</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Approve or deny with an optional comment. The comment is saved with the
 * decision and shown to everyone on the request.
 */
export function DecisionDialog({
  open,
  approve,
  title,
  description,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  approve: boolean;
  title: string;
  description?: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (comment: string) => void;
}) {
  const t = useT("time");
  const [comment, setComment] = useState("");
  // A fresh box each time it opens; kept while open so a failed save keeps the text.
  useEffect(() => {
    if (open) setComment("");
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setComment("");
          onCancel();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Label htmlFor="decision-comment">{t("Comment (optional)")}</Label>
          <Textarea
            id="decision-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={1000}
            rows={3}
            placeholder={approve ? t("Anything to add?") : t("Why is it being denied?")}
          />
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setComment("");
              onCancel();
            }}
          >
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            variant={approve ? "default" : "destructive"}
            disabled={busy}
            onClick={() => onConfirm(comment.trim())}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {approve ? t("Approve") : t("Deny")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
