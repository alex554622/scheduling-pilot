import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Megaphone, MessageSquare, Send, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The day's board: announcements from the office and short notes from anyone.
 *
 * Everything on it is gone after 24 hours. That is the database's rule, not
 * this page's — the read policy on `company_messages` will not return an older
 * row to anybody — so this is somewhere to say what matters today, not a chat
 * history to scroll back through. The page drops an expired post off the screen
 * at the minute it expires, so what is shown matches what could be read.
 */
export const Route = createFileRoute("/_authenticated/messages")({
  component: MessagesPage,
});

interface Message {
  id: string;
  company_id: string;
  author_id: string;
  body: string;
  is_announcement: boolean;
  created_at: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LEN = 1000;

/** "5m ago", "3h ago" — posts never get older than a day. */
function ago(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** How long it has left on the board. */
function left(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / 60_000));
  if (m < 60) return `${m}m left`;
  return `${Math.floor(m / 60)}h left`;
}

function MessagesPage() {
  const { user, profile, primaryRole } = useAuth();
  const qc = useQueryClient();
  const companyId = profile?.company_id ?? null;
  const isAdmin = primaryRole === "company_admin";

  const [draft, setDraft] = useState("");
  const [announce, setAnnounce] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Once a minute: enough to keep "3h ago" honest and to drop a post off the
  // board at the minute it expires.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const messagesQ = useQuery({
    queryKey: ["company-messages", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      // No date filter needed: the read policy already refuses anything older
      // than a day. Asking again here would only be a second opinion.
      const { data, error } = await supabase
        .from("company_messages")
        .select("id, company_id, author_id, body, is_announcement, created_at")
        .eq("company_id", companyId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Message[];
    },
  });

  // Names for the authors. Anyone in the company can read these already.
  const namesQ = useQuery({
    queryKey: ["message-author-names", companyId],
    enabled: !!companyId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("company_id", companyId!);
      if (error) throw error;
      return new Map((data ?? []).map((p) => [p.id, p.full_name || "Unnamed"]));
    },
  });

  // Live: a post from anyone appears on everyone's board without a refresh.
  useEffect(() => {
    if (!companyId) return;
    const ch = supabase
      .channel(`company-messages-${companyId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "company_messages",
          filter: `company_id=eq.${companyId}`,
        },
        () => void qc.invalidateQueries({ queryKey: ["company-messages", companyId] }),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [companyId, qc]);

  const post = useMutation({
    mutationFn: async () => {
      const body = draft.trim();
      if (!body) return;
      const { error } = await supabase.from("company_messages").insert({
        company_id: companyId!,
        author_id: user!.id,
        body,
        // The database refuses this from anyone but an admin; sending false
        // from everyone else keeps the refusal from ever being the answer.
        is_announcement: isAdmin && announce,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setDraft("");
      setAnnounce(false);
      void qc.invalidateQueries({ queryKey: ["company-messages", companyId] });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("company_messages").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["company-messages", companyId] }),
  });

  // Announcements pinned above the day's notes, each group newest first.
  const { announcements, notes } = useMemo(() => {
    const live = (messagesQ.data ?? []).filter(
      (m) => now - new Date(m.created_at).getTime() < DAY_MS,
    );
    return {
      announcements: live.filter((m) => m.is_announcement),
      notes: live.filter((m) => !m.is_announcement),
    };
  }, [messagesQ.data, now]);

  const nameOf = (id: string) =>
    id === user?.id ? "You" : (namesQ.data?.get(id) ?? "Someone");

  const tooLong = draft.length > MAX_LEN;

  if (!companyId) {
    return <p className="text-sm text-muted-foreground">Messages belong to a company.</p>;
  }

  const renderMessage = (m: Message) => {
    const age = now - new Date(m.created_at).getTime();
    const canDelete = m.author_id === user?.id || isAdmin;
    return (
      <li
        key={m.id}
        className={`rounded-xl border p-4 ${
          m.is_announcement
            ? "border-primary/40 bg-primary-soft/40"
            : "border-border bg-card"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
              {m.is_announcement && <Megaphone className="h-4 w-4 shrink-0 text-primary" />}
              {nameOf(m.author_id)}
              <span className="text-xs font-normal text-muted-foreground">
                {ago(age)} · {left(DAY_MS - age)}
              </span>
            </p>
            {/* Whitespace kept: a list typed with line breaks should read as one. */}
            <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-foreground">
              {m.body}
            </p>
          </div>
          {canDelete && (
            <button
              type="button"
              onClick={() => {
                if (confirm("Delete this message for everyone?")) remove.mutate(m.id);
              }}
              disabled={remove.isPending}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label="Delete message"
              title={m.author_id === user?.id ? "Delete your message" : "Delete (admin)"}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Messages</h1>
        <p className="text-sm text-muted-foreground">
          Today's board for the whole team. Everything posted here disappears after 24 hours.
        </p>
      </div>

      {/* Composer */}
      <form
        className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)]"
        onSubmit={(e) => {
          e.preventDefault();
          if (!tooLong && draft.trim()) post.mutate();
        }}
      >
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            isAdmin && announce
              ? "Write an announcement for everyone…"
              : "Write a message for the team…"
          }
          rows={3}
          className="resize-none"
          onKeyDown={(e) => {
            // Enter posts; Shift+Enter is a new line, the way every chat box works.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!tooLong && draft.trim()) post.mutate();
            }
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {isAdmin && (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={announce}
                  onChange={(e) => setAnnounce(e.target.checked)}
                  className="h-4 w-4 accent-[var(--primary)]"
                />
                <Megaphone className="h-4 w-4 text-primary" />
                Announcement
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  — pinned, and everyone is notified
                </span>
              </label>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`text-xs ${tooLong ? "font-medium text-destructive" : "text-muted-foreground"}`}
            >
              {draft.length}/{MAX_LEN}
            </span>
            <Button type="submit" size="sm" disabled={!draft.trim() || tooLong || post.isPending}>
              {post.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              Post
            </Button>
          </div>
        </div>
        {(post.error || remove.error) && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {((post.error ?? remove.error) as Error).message}
          </p>
        )}
      </form>

      {messagesQ.isLoading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
      ) : messagesQ.error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {(messagesQ.error as Error).message}
          <span className="mt-1 block text-xs text-muted-foreground">
            If this says the table is missing, the messages migration hasn't been applied to this
            database yet.
          </span>
        </p>
      ) : announcements.length === 0 && notes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center">
          <MessageSquare className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing posted in the last 24 hours.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {announcements.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Announcements
              </h2>
              <ul className="space-y-2">{announcements.map(renderMessage)}</ul>
            </section>
          )}
          {notes.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Today
              </h2>
              <ul className="space-y-2">{notes.map(renderMessage)}</ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
