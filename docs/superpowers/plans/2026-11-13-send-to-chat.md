# Send saved work items to the current conversation

Add a secondary **Send to chat** action in work-item details, including stories,
tasks, and features. Send a fresh saved ADO snapshot through the owning Copilot
session's `send({ prompt, mode: "enqueue" })`; do not start another session or
start implementation automatically. Preserve unsaved editor and comment drafts.

1. Build a bounded text snapshot with a permanent item link, identity/state,
   description, acceptance criteria, child items, and recent discussion. Keep
   Markdown and convert HTML to text. Mark omitted/truncated context.
2. Add a nonce-protected POST route that resolves the selected connection and
   project, reads ADO, and sends through the existing session. Do not accept a
   caller-supplied prompt. Report unavailable sessions and send failures.
3. Add pending, success, and error feedback without rerendering the editor.
   Prevent duplicate clicks while pending; retain status across tab rendering.
4. Verify prompt bounds, authenticated HTTP handoff with a fake SDK, frontend
   scope/draft handling, and desktop/narrow layouts in headless Brave.
5. Update documentation and plugin version, review, commit, and publish the fork.

Live Copilot delivery requires the user's installed host; local tests stub only
the session boundary. No real ADO writes or chat messages are needed for tests.

## Verification

- 146 prompt, work-item mapping, view, and app tests passed; three targeted
  server tests passed (chat handoff and existing detail/connection behavior).
- Headless Brave smoke passed at desktop, 900px, and 390px, including pending
  sends across rerendering, failure/retry, and preserving unsaved assignment.
- The full suite had 23 failures. An archive of the unchanged release reproduced
  the same 23 failure names; none were introduced by this change.
- Independent review identified numeric ADO text formats; the shared format
  normalizer now handles them, with a regression test. Follow-up review passed.
- No live Copilot chat delivery or authenticated ADO writes were performed.
