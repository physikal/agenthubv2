# Unified Workspace Backup — Web UI Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the consolidated workspace backup a UI: an admin "Workspace Backup" page (any/all users: run, history, download, restore) and a reworked per-user Backups page ("back up my workspace now" + my snapshots: download + restore), wired to the new `/api/(admin|user)/workspace-backup` endpoints; plus fix the two pages that referenced the removed `/api/user/backup`.

**Architecture:** Mirror the existing Install Backup admin UI (`pages/admin/InstallBackup.tsx` + `components/install-backup/*`) and the app's hand-rolled SSE-log streaming. Extract ONE shared SSE-run helper (the loop is currently copy-pasted ~6 places) and use it in the new code. React 19 + Vite + Tailwind (zinc/purple palette), zustand `useAuthStore` for role. Backend (Plan 1) is already merged on this branch.

**Tech Stack:** React 19, Vite, TypeScript (strict; `verbatimModuleSyntax`), Tailwind. **No vitest in `packages/web`** — verification is `tsc --noEmit` + manual browser testing on a live stack (documented per task).

**Spec:** `docs/superpowers/specs/2026-05-20-unified-workspace-backup-design.md` · **Plan 1:** `docs/superpowers/plans/2026-05-20-unified-workspace-backup-backend.md`

---

## Endpoints (from Plan 1, already live)

- `POST /api/admin/workspace-backup/run` — body `{ userId?, all?, noB2?, note? }`, **SSE** (`event: log`/`done`/`error`). 400 if neither userId nor all.
- `GET /api/admin/workspace-backup/runs?userId=` → `{ runs }`.
- `GET /api/admin/workspace-backup/download/:userId/:filename` — attachment.
- `POST /api/admin/workspace-backup/restore/run` — header `Confirm-Restore: yes-i-know-what-this-does`; body `{ userId, source: {kind:"b2-snapshot",snapshot:"latest"|name} | {kind:"local",filename}, force? }`, **SSE**.
- `POST /api/user/workspace-backup/run` — **SSE**; backs up the authed user.
- `GET /api/user/workspace-backup` → `{ runs }` (own).
- `GET /api/user/workspace-backup/download/:filename` — attachment (own).
- `POST /api/user/workspace-backup/restore/run` — header `Confirm-Restore: …`; body `{ source, force? }`, **SSE**; throws (SSE `error`) if the user has a live session.
- `GET /api/admin/users` → user list (existing, `admin.ts:52`) for the admin selector.
- A "run" row shape (`backup_runs`): `{ id, userId, kind:"save"|"restore", status:"running"|"success"|"failed", startedAt, endedAt, bytes, localPath, b2Path, trigger, error }`.

`api(path, options?)` (`lib/api.ts:87`) returns the raw `Response` (`credentials:include`); callers do `.ok`/`.json()`. SSE bodies are read with `res.body.getReader()` + `TextDecoder` + `split("\n\n")`.

---

## File Structure

**Create:**
- `packages/web/src/lib/sse.ts` — shared `streamRun()` SSE helper (+ re-export from `lib/api.ts` if convenient).
- `packages/web/src/pages/admin/WorkspaceBackup.tsx` — admin page (header + cards).
- `packages/web/src/components/workspace-backup/RunCard.tsx` — pick user/all → run, SSE log.
- `packages/web/src/components/workspace-backup/HistoryTable.tsx` — runs table + download + restore trigger (admin: any user).
- `packages/web/src/components/workspace-backup/RestoreCard.tsx` — admin restore (b2-snapshot/local) with confirm.

**Modify:**
- `packages/web/src/pages/Backups.tsx` — rebuild onto `/api/user/workspace-backup` (remove dead B2-config + versioning UI).
- `packages/web/src/pages/Secrets.tsx` — replace `/api/user/backup` readiness probe with `/api/user/workspace-env`.
- `packages/web/src/pages/Integrations.tsx` — remove the orphaned per-user `b2` provider option.
- `packages/web/src/App.tsx` — register `/admin/workspace-backup` route.
- `packages/web/src/components/Sidebar.tsx` — add admin nav entry.

---

## Task 1: Shared SSE-run helper

**Files:** Create `packages/web/src/lib/sse.ts`.

- [ ] **Step 1: Implement** (mirrors the loop in `components/install-backup/BackupCard.tsx:42-63`):

```typescript
import { api } from "./api.ts";

export interface SSERunHandlers {
  onLog?: (line: string) => void;
  onDone?: (data: string) => void;
  onError?: (data: string) => void;
}

/** POST `path` with `body` and consume an `event: log|done|error` SSE stream.
 * Resolves when the stream ends. Network/non-OK failures call onError. */
export async function streamRun(
  path: string,
  body: unknown,
  handlers: SSERunHandlers,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  let res: Response;
  try {
    res = await api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    handlers.onError?.(err instanceof Error ? err.message : "request failed");
    return;
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    handlers.onError?.(text || `HTTP ${res.status}`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const lines = part.split("\n");
      const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
      const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (event === "log") handlers.onLog?.(data);
      else if (event === "done") handlers.onDone?.(data);
      else if (event === "error") handlers.onError?.(data);
    }
  }
}
```

- [ ] **Step 2: Typecheck** `pnpm --filter @agenthub/web typecheck` (must pass).
- [ ] **Step 3: Commit** `git add packages/web/src/lib/sse.ts && git commit -m "feat(web): shared SSE run helper"`

> Do NOT refactor the existing install-backup cards onto this helper (leave working code); use it only in the new/ reworked code below.

---

## Task 2: Admin Workspace Backup page

**Files:** Create the page + 3 components; modify `App.tsx`, `Sidebar.tsx`. Mirror `pages/admin/InstallBackup.tsx` (header + `space-y-6` stacked cards) and `components/install-backup/{BackupCard,HistoryTable,RestoreCard}.tsx` for styling (`bg-zinc-900 border border-zinc-800 rounded-xl p-5`, purple accent, `<pre className="text-xs bg-zinc-950 ... font-mono">` for logs, red/amber for destructive).

- [ ] **Step 1: `components/workspace-backup/RunCard.tsx`** — a card with: a `<select>` populated from `GET /api/admin/users` (options: each `{id, username}` + a synthetic "All users" option), a `noB2` checkbox, a "Back up" button, and a `<pre>` log. On click call `streamRun("/api/admin/workspace-backup/run", all ? { all: true, noB2 } : { userId, noB2 }, { onLog: append, onDone: ()=>{ setRunning(false); onChanged(); }, onError: ...})`. Take an `onChanged` prop to refresh the history table. Disable button while running.

- [ ] **Step 2: `components/workspace-backup/HistoryTable.tsx`** — props `{ userId: string | null; reloadKey: number; onRestore(run): void }`. Fetch `GET /api/admin/workspace-backup/runs${userId?`?userId=${userId}`:""}` → `{runs}`. Render a table (mirror `install-backup/HistoryTable.tsx`): columns user/kind/status/started/bytes; a **Download** anchor `<a href={`/api/admin/workspace-backup/download/${run.userId}/${filename}`}>` where `filename = run.localPath?.split("/").pop()` (only when `run.kind==="save" && run.localPath`); a **Restore** button calling `onRestore(run)` (passes userId+filename). Show `error` in an expandable row like the install-backup table.

- [ ] **Step 3: `components/workspace-backup/RestoreCard.tsx`** — destructive card (amber/red border). Inputs: target userId (text or prefilled from `onRestore`), a source selector — either `b2-snapshot` (text input, default `latest`) or `local` (filename text), and a `force` checkbox. A confirm checkbox "I understand this replaces the user's /home/coder and requires their sessions to be ended". On submit call `streamRun("/api/admin/workspace-backup/restore/run", { userId, source, force }, handlers, { "Confirm-Restore": "yes-i-know-what-this-does" })`. Render the SSE log. (No `/validate` step exists for workspace — unlike install-backup; skip it.)

- [ ] **Step 4: `pages/admin/WorkspaceBackup.tsx`** — `export function WorkspaceBackupPage()`: header + `useState` `reloadKey` + selected restore target. Stack `<RunCard onChanged={()=>setReloadKey(k=>k+1)} />`, `<HistoryTable userId={null} reloadKey={reloadKey} onRestore={setRestoreTarget} />`, `<RestoreCard target={restoreTarget} onChanged={()=>setReloadKey(k=>k+1)} />`. Match `InstallBackupPage`'s 23-line shape.

- [ ] **Step 5: Register route** in `packages/web/src/App.tsx` (next to `/admin/install-backup`, App.tsx:35):
```tsx
import { WorkspaceBackupPage } from "./pages/admin/WorkspaceBackup.tsx";
// ...
<Route path="/admin/workspace-backup" element={<WorkspaceBackupPage />} />
```

- [ ] **Step 6: Add nav** in `packages/web/src/components/Sidebar.tsx` `adminLinks` (Sidebar.tsx:25):
```tsx
{ to: "/admin/workspace-backup", label: "Workspace Backup", icon: "●" },
```

- [ ] **Step 7: Typecheck** `pnpm --filter @agenthub/web typecheck` (must pass).
- [ ] **Step 8: Commit** `git add packages/web/src/pages/admin/WorkspaceBackup.tsx packages/web/src/components/workspace-backup/ packages/web/src/App.tsx packages/web/src/components/Sidebar.tsx && git commit -m "feat(web): admin Workspace Backup page"`

---

## Task 3: Rework the per-user Backups page

**Files:** Modify `packages/web/src/pages/Backups.tsx` (currently 504 lines, calls removed `/api/user/backup*`). Rebuild it onto `/api/user/workspace-backup`. Remove the dead B2-config section (per-user B2 is gone) and the versioning UI (snapshots ARE the versions now).

- [ ] **Step 1: Replace the page body** with:
  - **Back up now:** a button → `streamRun("/api/user/workspace-backup/run", {}, { onLog: append, onDone: ()=>{setRunning(false); reloadRuns();}, onError })` + a `<pre>` log.
  - **My snapshots:** fetch `GET /api/user/workspace-backup` → `{runs}`. Table: kind/status/started/bytes; **Download** anchor `<a href={`/api/user/workspace-backup/download/${filename}`}>` (filename from `run.localPath?.split("/").pop()`, save runs only); **Restore** button.
  - **Restore:** clicking Restore on a row opens a confirm (inline section or modal) that warns "This replaces your workspace and requires ending your active sessions first," with a confirm checkbox, then `streamRun("/api/user/workspace-backup/restore/run", { source: { kind:"local", filename } }, handlers, { "Confirm-Restore":"yes-i-know-what-this-does" })`. Surface the SSE `error` text (e.g. the active-session message) inline.
  - Keep `StatusBadge` (Backups.tsx:492) if still useful; delete `VersioningBanner` and all `/backup/versioning`, `/backup/status`, `BackupConfig`, B2 form state.

- [ ] **Step 2: Typecheck** `pnpm --filter @agenthub/web typecheck` (must pass; ensure no leftover references to removed types/endpoints — grep `rg "user/backup[^-]" packages/web/src/pages/Backups.tsx` returns nothing).
- [ ] **Step 3: Commit** `git add packages/web/src/pages/Backups.tsx && git commit -m "feat(web): rework Backups page onto workspace-backup endpoints"`

---

## Task 4: Fix Secrets page store-readiness probe

**Files:** Modify `packages/web/src/pages/Secrets.tsx` (lines ~26-50).

- [ ] **Step 1:** Replace the `GET /api/user/backup` probe with `GET /api/user/workspace-env`. Treat `res.ok` as ready and `res.status === 503` as not-ready:
```typescript
const res = await api("/api/user/workspace-env");
const storeReady = res.status !== 503; // 200 => store reachable; 503 => SecretStoreNotConfigured
```
Remove the now-irrelevant `configured`/`storeReady`-from-body parsing and the stale comment about reusing `/api/user/backup`. Keep the rest of the Secrets page behavior identical.

- [ ] **Step 2: Typecheck** + grep `rg "user/backup" packages/web/src/pages/Secrets.tsx` → no matches.
- [ ] **Step 3: Commit** `git add packages/web/src/pages/Secrets.tsx && git commit -m "fix(web): probe workspace-env for secret-store readiness"`

---

## Task 5: Remove the orphaned per-user B2 provider

**Files:** Modify `packages/web/src/pages/Integrations.tsx`. The per-user `b2` integration (provider rows in `infrastructure_configs`) is no longer consumed by anything after Plan 1; remove its UI entry points. (Do NOT touch the operator install-backup B2, which is a separate config under Settings → Admin → Install Backup.)

- [ ] **Step 1:** Remove from `Integrations.tsx`:
  - the `| "b2"` member of the provider union (Integrations.tsx:14),
  - the `case "b2":` input block (Integrations.tsx:340-345),
  - the `<option value="b2">Backblaze B2 (backups)</option>` (Integrations.tsx:482).
  Grep the file for any other `b2`/`b2KeyId`/`b2AppKey` reference and remove it. Leave the server enum as-is (existing rows persist; backend cleanup is out of scope).

- [ ] **Step 2: Typecheck** (must pass — confirm no exhaustiveness/type error from dropping the union member). Grep `rg "\"b2\"|'b2'|b2KeyId|b2AppKey" packages/web/src/pages/Integrations.tsx` → no matches.
- [ ] **Step 3: Commit** `git add packages/web/src/pages/Integrations.tsx && git commit -m "refactor(web): remove orphaned per-user B2 integration"`

---

## Task 6: Final verification

- [ ] **Step 1: Typecheck the whole web package** `pnpm --filter @agenthub/web typecheck` (clean).
- [ ] **Step 2: Build** `pnpm --filter @agenthub/web build` (must succeed — catches anything `tsc --noEmit` misses in the Vite/`tsc -b` path).
- [ ] **Step 3: Grep for any remaining dead references across web** `rg -n "/api/user/backup([^-]|$)|/backup/versioning|/backup/save|/backup/status" packages/web/src` → no matches.
- [ ] **Step 4: Manual verification (on a live stack — cannot run here).** Document in the commit/PR: as admin, open Settings → Workspace Backup, run "Back up all" (watch SSE log), confirm a run row + Download works, restore a snapshot for a user with no active session; as a regular user, open Backups, "Back up my workspace now", Download, attempt restore (confirm the "end your sessions" guard message appears when a session is live); confirm Secrets page still loads; confirm Integrations no longer offers B2.

---

## Self-Review

**Spec coverage:** admin manage (any/all run, history, download, restore) → Task 2; per-user back-up-now + history + download + restore → Task 3; B2-optional/noB2 → Task 2 RunCard; restore everywhere + Confirm-Restore + active-session guard surfaced → Tasks 2,3. Removed-endpoint fallout (Secrets, Integrations b2) → Tasks 4,5. ✓

**Placeholder scan:** the new logic (SSE helper) has full code; the page/component bodies specify exact endpoints, payloads, headers, props, and the existing files to mirror (`install-backup/*`) — the executor copies that proven styling rather than re-deriving it.

**Type consistency:** `streamRun(path, body, handlers, extraHeaders?)` signature used identically in Tasks 2 & 3; run-row fields (`localPath`/`bytes`/`kind`/`status`) match the `backup_runs` shape from Plan 1; restore body `{ userId?, source, force? }` + `Confirm-Restore` header match the Plan-1 routes.

**Convention note:** `packages/web` has no test runner, so there are no unit-test steps — verification is typecheck + build + manual browser testing (explicit in Task 6). This matches the codebase (web is untested by convention); introducing vitest is out of scope.
