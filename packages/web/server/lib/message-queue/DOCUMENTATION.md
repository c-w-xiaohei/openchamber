# Message Queue

## Purpose

Owns the messages a user queued while a session was busy, and sends them the
moment the session goes idle. The queue lives in the web server so a closed
tab, a locked phone, or a dropped connection no longer strands it. Structural
template: `permission-auto-accept` — the server is authoritative, the shared UI
renders a projection, and VS Code (which has no server of its own) keeps its
UI-side queue and foreground auto-send hook.

## Files

- `runtime.js` — `createMessageQueueRuntime(...)` (state, persistence,
  dispatch loop, event handling) and `registerMessageQueueRoutes(app, runtime)`.
- `runtime.test.js` — delivery, idleness gates, retries, holds, persistence,
  concurrency with in-flight sends, slash commands, and project knowledge.

Wiring: created in `server/index.js` after the global event hub and the
session-knowledge runtime; routes registered in
`opencode/feature-routes-runtime.js` (before the generic OpenCode proxy) with
JSON bodies enabled in `opencode/core-routes.js`; stopped by
`opencode/shutdown-runtime.js`.

## Auto routing

`resolveAutoSelection` (the routing runtime) runs right before the send when
the queued send config names `openchamber/auto`, and answers with the real
model and agent. OpenCode 2.x holds both on the session, so the queue applies
them with the `POST /api/session/:id/model` and `/agent` calls it already
makes. The queue captures the sentinel like any other send config.

## Item

An item is what the UI would have sent itself, captured at queue time so the
send never re-resolves mutable UI state:

```
{
  id, createdAt,
  content,        // raw text for display and editing
  contextPreview?, // bounded display-only summary captured by the UI
  text,           // text to deliver (agent mention stripped, file mentions resolved); defaults to content
  agentMention?,  // delivered as an `agent` part
  attachments: [{ id, filename, mimeType, size, source, serverPath?, dataUrl }],
  context: [      // what the composer had attached, in send order
    { kind: 'context', text, metadata, instructions? },  // a draft chip or linked issue/PR; metadata is the UI's structured payload
    { kind: 'instruction', text },                       // derived from the text (skill instruction)
    { kind: 'synthetic', text },                         // handed to the composer by another surface
  ],
  sendConfig: { providerID, modelID, agent?, variant? }   // required
}
```

The server is a courier for `context`: it validates the shape (a kind it
knows, a `metadata` object on `context` entries) and delivers each entry as a
synthetic text part, an entry's `instructions` going out as its own part just
before it and its `metadata` riding the part verbatim so the timeline renders
the context block back. The payload inside `metadata` is the UI's contract
(`lib/messages/contextParts.ts`), parsed by the UI on the way back.

`parseQueuedItemInput` rejects anything the server could not deliver later
(no text, attachments, or context; missing model; malformed attachment or
context entry). Public snapshots and broadcasts strip the payloads —
attachment `dataUrl` (megabytes of base64) and `context` (a PR diff, say) —
so they do not ride every update; the only way to get them back is a `take`.

Snapshots retain `contextPreview`, capped at 100 characters plus an ellipsis.
It carries the attached comment or context label when `content` is empty and
never replaces editable text or delivered parts. Older items without a summary
derive one from the attached comment metadata or the first non-instruction
context text. This optional field needs no queue-file migration.

## Persistence

`<data-dir>/message-queue.json` (`OPENCHAMBER_DATA_DIR` or
`~/.config/openchamber`): `{ version, revision, sessions: { [sessionId]:
{ directory, items, manualClaims } } }`, written atomically (temp file + rename) through a
serialized write chain. A missing file is an empty queue. A malformed file is
a failure, not an empty queue: it is moved aside as
`message-queue.json.corrupt-<timestamp>` before the runtime starts empty, so
the next write cannot overwrite the user's data. A failed read leaves writes
disabled until a later load succeeds. `revision` is a global monotonic counter
bumped on every mutation; clients use it to reject stale snapshots.

Version 2 persists started manual claims by exact queue item ID with their token,
optimistic `messageID`, and `dispatched` flag. Start and dispatch wait for the
serialized atomic write before returning or contacting OpenCode. Loading restores
pending ownership before arming delivery. Version 1 files have no operation state
and remain readable. Invalid operation records fail loading rather than restoring
possibly accepted items as retryable. Automatic sends, retry backoff, abort
timestamps, and holds remain transient. This is process-restart durability, not
a power-loss guarantee: the existing atomic writer does not fsync the file or directory.
Delivery waits for pending writes and retries failed writes before sending again.

## Delivery loop

1. `start()` subscribes to the global upstream hub and loads the file; on
   load and on every hub `connect` it arms every session that has items.
2. `session.status` for a queued session: `idle` arms a short quiet timer
   (500 ms, coalescing the burst around a turn boundary), `busy`/`retry`
   clears it unless a manual claim needs reconciliation. A `message.updated` for a completed assistant reply arms as
   well, so a missed idle event cannot strand the queue. `session.deleted`
   drops the session's queue. An assistant `MessageAbortedError` records an
   abort.
3. `tick(sessionId)` only delivers the head. An unresolved head blocks both
   automatic delivery and the start of a later manual batch. An unstarted manual
   claim may expire after five seconds. A started claim is reconciled independently
   of browser presence, even while held or busy, using the policy below.
   Delivery re-arms after a 2 s post-abort hold (the UI's
   old behavior: a stop is not immediately followed by the next prompt) or
   while the head item is in retry backoff.
4. Idleness is re-verified against OpenCode before sending, because
   a prompt into a running turn steers into it instead of starting the
   next one: `GET /api/session/active` must not list the session, and the
   trailing message must not be an unfinished assistant reply (that route
   lists only running sessions, so a missed busy event leaves no entry while
   a turn still streams). An unfinished reply created before this
   runtime started does not block: its run died with the previous server and
   will never complete, so a restored queue would wait on it forever. A reply
   with no `created` time still blocks. A failed fetch is unknown, never idle:
   the tick re-arms with backoff.
   The turn must also be over for the session's subagents: a parent idles
   while a background subagent works and runs again when OpenCode hands the
   result back. While `../opencode/session-activity.js` finds a running child
   the head waits (the rerun's idle event re-arms it, a 5 s recheck covers a
   missed one); a failed check is unknown and backs off like the rest.
5. The head is marked in flight (broadcast), then sent. The captured model and
   agent are switched onto the session first (`POST /session/:id/model`,
   `/agent`), because v2 holds both on the session rather than in the body; a
   captured `openchamber/auto` is resolved into a real pair by the routing
   runtime beforehand. Then the captured context goes ahead as synthetic
   messages (`POST /session/:id/synthetic` with `resume: false`, an attached
   item's metadata riding along), followed by pending project knowledge
   (`sessionKnowledgeRuntime.resolvePendingForSession`, recorded as delivered
   only after the send is accepted), and then the message itself:
   - text starting with `/` that names a command in OpenCode's `/command`
     list (skills included) goes to `POST /session/:id/command` (body fields
     `name` and `text` since OpenCode 2.0.8) with its file attachments. The
     command route takes files only, which is why the context went ahead of
     it; sending "/name args" as a prompt instead would skip the template
     OpenCode expands only on that route. The command lookup runs before
     anything is admitted, so a failed lookup fails the send without leaving
     context behind for the retry to duplicate;
   - otherwise `POST /session/:id/prompt` with the user's text, files and
     agent mention.
   Success removes the item, persists, broadcasts, and marks the user
   message sent for notifications. Failure keeps the item, backs off
   2 s → 60 s (doubling per consecutive failure of that item), and re-arms.
6. The next item goes out after the next busy → idle cycle.

## Manual send recovery

The composer generates its optimistic message ID before awaiting the start route.
Start binds the token's exact ordered queue prefix to that ID. Repeated starts
with the same identity are safe; a different identity or stale token is rejected.
The SDK still builds native V2 `/api/session/:id/prompt` and `/command` requests.
The prompt body uses `id`, `text`, and `files`; command uses `name` and `text`.
For server-owned manual sends only, its per-request fetch sends that body through
`manual-send/dispatch`. The queue runtime validates ownership and persists
`dispatched: true` before forwarding through its existing OpenCode URL/auth helper.
It never forwards the same claim twice. A resumed browser cannot send after release.

Every five seconds, one reconciliation per queued session looks up the exact
`GET /api/session/:id/message/:messageID`. A matching flat V2 user record acknowledges only
that operation's queue IDs, even when the session is busy. A 404 alone is not enough
to release. Release requires `dispatched: false` and two consecutive successful
idle/absent observations at least five seconds apart. Busy, malformed responses,
and failed reads reset confirmation. Restart also resets confirmation.

Once dispatch may have reached OpenCode, idle and absence cannot prove rejection.
The claim remains pending and reconciliation continues without resending. A crash
between persisting dispatch and upstream I/O can therefore retain an unsent claim.
If that pre-upstream persistence write itself fails, the still-current in-memory
claim is restored to `dispatched: false`, so a later definite rejection or normal
reconciliation can release it once persistence recovers. This conservative gap needs
upstream operation fencing to recover automatically; there is no TTL-based release.
Definite upstream rejection releases the exact claim; ambiguous dispatch returns 503
and leaves it protected. OpenCode acceptance remains success even if the local ACK
write fails, and the disk claim can reconcile on restart.

V2 commands allocate their own message ID. Their start identity fences queue
ownership only; it is not sent as a command message ID. A successful command
response settles the claim, but a lost command response cannot be confirmed
using that identity. Such a claim stays protected rather than guessing a matching
history entry or resending the command.

Automatic delivery's existing ambiguous-error retry and transient in-flight state
are unchanged by this manual-send protocol. It does not provide exactly-once
delivery for automatic sends across transport failure or process restart. Older
browsers without a message ID cannot start a claim and must reload; older servers
cannot safely implement this protocol. Downgrading with pending version-2 claims
is unsupported.

## Holds

Auto-review is driven from the UI and bounces the original session through
idle between iterations; the UI tells the server to hold that session's queue
(`PUT .../hold { held: true, ttlMs? }`) while a run is going and releases it
when the run ends. A hold expires on its own (default 5 min, cap 10 min)
because the UI that asserted it may be gone; the UI re-asserts it every two
minutes while the run continues. Releasing arms a dispatch.

## Routes (`/api/message-queue`)

Normal authenticated OpenChamber runtime routes; never on browser URL-token
allowlists.

| Route | Purpose |
|---|---|
| `GET /api/message-queue` | Full snapshot `{ revision, sessions[] }` |
| `POST .../sessions/:id/items` | Append `{ directory, item }`; returns `{ revision, session, itemId }` and arms a dispatch (the session may already be idle) |
| `DELETE .../sessions/:id/items/:itemId` | Remove; `409` while that item is in flight |
| `POST .../sessions/:id/items/:itemId/take` | Remove and return the full item (payloads included) for editing; `404`/`409` |
| `POST .../sessions/:id/take` | Remove and return every item not in flight, in order |
| `PUT .../sessions/:id/order` | `{ itemIds }` must be a complete permutation |
| `DELETE .../sessions/:id` | Clear; the in-flight item stays |
| `PUT .../sessions/:id/hold` | `{ held, ttlMs? }` |
| `POST .../sessions/:id/manual-send` | Claim eligible `{ itemIds }` and return full payloads without removal; already-pending IDs are omitted |
| `POST .../sessions/:id/manual-send/start` | Durably bind `{ itemIds, token, messageID }`; exact repeats are idempotent |
| `POST .../sessions/:id/manual-send/dispatch` | Forward the SDK `{ itemIds, token, endpoint, body }` once, only while its exact claim is current |
| `POST .../sessions/:id/manual-send/ack` | Remove exactly the tokenized acknowledged items; repeats after a lost response are idempotent |
| `POST .../sessions/:id/manual-send/fail` | Release exactly the tokenized, definitely rejected items for retry |

Every mutation broadcasts `openchamber:message-queue.updated` with
`{ revision, session }` to all connected clients (SSE and WS), so several
devices on one server see one queue. SSE uses the shared control stream at
`/api/openchamber/events`; `/api/global/event` carries no OpenChamber events.
The UI subscribes independently of its OpenCode transport and re-reads the
snapshot whenever either stream reconnects. The session in that payload always names
its `directory`, including the broadcast that removes the last item: the UI
keys its projection by directory, and a broadcast without one left the
delivered message on screen (a session's directory is remembered until the
session is deleted or evicted).

Limits: 20 items per session (additional enqueue is rejected, never evicting the pending head), 50 sessions (oldest evicted, never one with an
item in flight), 200k characters of content; attachment payloads are bounded
by the route family's 50 MB JSON limit.

## UI ownership

`packages/ui/src/stores/messageQueueStore.ts` is the projection: see its
section in `packages/ui/src/stores/DOCUMENTATION.md`. VS Code intentionally
does not use this module; with all OpenChamber webviews closed, queued
messages there are not delivered.
