import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageQueueRuntime, parseQueuedItemInput } from './runtime.js';

const SESSION = 'ses_queue_test_1';
const DIRECTORY = '/repo';

const item = (overrides = {}) => ({
  content: 'follow up',
  text: 'follow up',
  attachments: [],
  sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'build' },
  ...overrides,
});

const tempDirs = [];
const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-message-queue-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake OpenCode: status map, message tail, command list, and a log of every
 * prompt/command it received.
 */
const createOpenCode = () => {
  const state = {
    // `/api/session/active` lists only running sessions; an absent id is idle.
    active: {},
    // Subagent sessions per parent, as `GET /api/session?parentID=` lists them.
    children: {},
    tail: [],
    commands: [],
    sent: [],
    switched: [],
    failNext: null,
  };
  // v2 wraps `/api/*` payloads in `{ location, data }`; a message page is
  // `{ data, cursor }` and lists newest first.
  const wrapped = (data) => Response.json({ location: { directory: DIRECTORY }, data });
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    if (state.failNext && state.failNext.test(pathname)) {
      state.failNext = null;
      return new Response('boom', { status: 500 });
    }
    // Real shape: `{ data }` without a `location`, unlike directory-scoped routes.
    if (pathname === '/api/session/active') return Response.json({ data: state.active });
    if (pathname === '/api/session' && method === 'GET') {
      const parentID = new URL(url).searchParams.get('parentID');
      return Response.json({ data: (state.children[parentID] ?? []).map((id) => ({ id, parentID })), cursor: {} });
    }
    if (pathname.endsWith('/message')) return Response.json({ data: state.tail, cursor: {} });
    if (pathname === '/api/command') return wrapped(state.commands);
    if (pathname.includes('/message/')) {
      const record = state.tail.find((entry) => entry.id === pathname.split('/').at(-1));
      return record ? wrapped(record) : new Response('not found', { status: 404 });
    }
    if (method === 'POST' && (pathname.endsWith('/model') || pathname.endsWith('/agent'))) {
      // Kept apart from `sent`: switching the session is not a message.
      state.switched.push({ path: pathname, body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && (pathname.endsWith('/prompt') || pathname.endsWith('/command') || pathname.endsWith('/synthetic'))) {
      state.sent.push({ path: pathname, body: JSON.parse(init.body) });
      return wrapped({ id: `msg_${state.sent.length}` });
    }
    return new Response('not found', { status: 404 });
  });
  return { state, fetchImpl };
};

const createRuntime = ({ dataDir = makeDataDir(), openCode = createOpenCode(), knowledge = null, retryDelayMs, resolveAutoSelection, now } = {}) => {
  let eventHandler = () => {};
  let statusHandler = () => {};
  const broadcasts = [];
  const promptSent = [];
  const options = {
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
      subscribeStatus(handler) { statusHandler = handler; return () => {}; },
    },
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    sessionKnowledgeRuntime: knowledge,
    broadcastGlobalUiEvent: (event) => broadcasts.push(event),
    onPromptSent: (sessionId) => promptSent.push(sessionId),
    dataDir,
    fetchImpl: openCode.fetchImpl,
    dispatchQuietMs: 0,
    abortHoldMs: 50,
  };
  if (retryDelayMs) options.retryDelayMs = retryDelayMs;
  if (resolveAutoSelection) options.resolveAutoSelection = resolveAutoSelection;
  if (now) options.now = now;
  const runtime = createMessageQueueRuntime(options);
  return {
    runtime,
    openCode,
    dataDir,
    broadcasts,
    promptSent,
    // The hub hands server-side subscribers already-translated events.
    emit: (payload, directory = DIRECTORY) => eventHandler({ payload, directory, translated: () => [payload] }),
    connect: () => statusHandler({ type: 'connect' }),
  };
};

const settle = async (ms = 30) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

describe('auto routing', () => {
  it('switches a queued prompt and a queued command onto the routed model and agent', async () => {
    const resolveAutoSelection = vi.fn(async ({ model }) => (model?.id === 'auto'
      ? { model: { providerID: 'openai', id: 'gpt-6-astra' }, agent: 'plan', decision: {} }
      : null));
    const { runtime, openCode, emit } = createRuntime({ resolveAutoSelection });
    runtime.start();
    openCode.state.active = { [SESSION]: { type: 'running' } };
    openCode.state.commands = [{ name: 'review', template: 'Review $ARGUMENTS' }];
    const auto = { providerID: 'openchamber', modelID: 'auto', agent: 'build' };
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain', sendConfig: auto }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '/review src', text: '/review src', sendConfig: auto }));

    openCode.state.active = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    // v2 carries no model in a prompt body: the session is switched first.
    const switched = openCode.state.switched.filter((entry) => entry.path.endsWith('/model'));
    expect(switched.map((entry) => entry.body.model)).toEqual([
      { providerID: 'openai', id: 'gpt-6-astra' },
      { providerID: 'openai', id: 'gpt-6-astra' },
    ]);
    expect(openCode.state.switched.filter((entry) => entry.path.endsWith('/agent')).map((entry) => entry.body.agent))
      .toEqual(['plan', 'plan']);
    expect(resolveAutoSelection).toHaveBeenCalledTimes(2);
    expect(resolveAutoSelection.mock.calls[0][0]).toMatchObject({ sessionId: SESSION, directory: DIRECTORY, requestText: 'plain' });
  });
});

describe('parseQueuedItemInput', () => {
  it('rejects an item the server could not deliver later', () => {
    expect(() => parseQueuedItemInput({ content: 'x' })).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ content: '', text: '' }))).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ attachments: [{ filename: 'a.png' }] }))).toThrow(TypeError);
  });

  it('keeps delivery fields and trims blank edges of the content', () => {
    const parsed = parseQueuedItemInput(item({ content: '\n\nhello\n', text: 'hello', agentMention: 'reviewer' }));
    expect(parsed).toEqual({
      content: 'hello',
      text: 'hello',
      agentMention: 'reviewer',
      attachments: [],
      context: [],
      sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'build' },
    });
  });

  it('keeps captured context and rejects a malformed part', () => {
    const context = [
      { kind: 'context', text: 'Comment on `a.ts`', metadata: { openchamberContext: { kind: 'code-comment' } }, instructions: '' },
      { kind: 'instruction', text: 'use the skill' },
      { kind: 'synthetic', text: 'conflict payload' },
    ];
    expect(parseQueuedItemInput(item({ context })).context).toEqual([
      { kind: 'context', text: 'Comment on `a.ts`', metadata: { openchamberContext: { kind: 'code-comment' } } },
      { kind: 'instruction', text: 'use the skill' },
      { kind: 'synthetic', text: 'conflict payload' },
    ]);
    expect(() => parseQueuedItemInput(item({ context: [{ kind: 'context', text: 'no metadata' }] }))).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ context: [{ kind: 'other', text: 'x' }] }))).toThrow(TypeError);
  });

  it('accepts an item that is only context', () => {
    const parsed = parseQueuedItemInput(item({ content: '', text: '', context: [{ kind: 'synthetic', text: 'just context' }] }));
    expect(parsed.text).toBe('');
    expect(parsed.context).toHaveLength(1);
  });
});

describe('message queue runtime', () => {
  it('delivers the head of the queue when the session goes idle, in order', async () => {
    const { runtime, openCode, emit, promptSent, broadcasts } = createRuntime();
    runtime.start();
    openCode.state.active = { [SESSION]: { type: 'running' } };

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first' }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'second', text: 'second' }));
    await settle(100);
    expect(openCode.state.sent).toHaveLength(0);

    openCode.state.active = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(100);

    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].path).toBe(`/api/session/${SESSION}/prompt`);
    // v2 selects model and agent on the session, so the prompt carries text
    // and attachments only.
    expect(openCode.state.sent[0].body).toEqual({ text: 'first' });
    expect(promptSent).toEqual([SESSION]);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['second']);
    // Clients learned about the in-flight item and then the removal.
    expect(broadcasts.at(-1)).toMatchObject({
      type: 'openchamber:message-queue.updated',
      properties: { session: { sessionId: SESSION, sendingId: null } },
    });

    // The next turn: busy, then idle again — the second message goes out.
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'busy' } } });
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(2);
    expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
  });

  it('waits for a background subagent before sending the queued message', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    // The parent paused: it is idle while its background subagent works.
    openCode.state.children = { [SESSION]: ['ses_child'] };
    openCode.state.active = { ses_child: { type: 'running' } };

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'next', text: 'next' }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    // The subagent finished and OpenCode ran the parent again with its result.
    openCode.state.active = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'busy' } } });
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].body).toEqual({ text: 'next' });
  });

  it('does not send into a running turn even when the status event says idle', async () => {
    const { runtime, openCode, emit } = createRuntime({ now: () => 10_000 });
    runtime.start();
    // Live unfinished turn: created after this runtime started.
    openCode.state.tail = [{ type: 'assistant', time: { created: 10_001 } }];
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    // The reply completes: that alone drains the queue (a missed idle event
    // must not strand it).
    openCode.state.tail = [{ type: 'assistant', time: { created: 10_001, completed: 10_002 } }];
    emit({ type: 'message.updated', properties: { info: { role: 'assistant', sessionID: SESSION, time: { created: 10_001, completed: 10_002 } } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('delivers past an unfinished tail that predates this runtime (dead pre-restart run)', async () => {
    const { runtime, openCode, emit } = createRuntime({ now: () => 10_000 });
    runtime.start();
    // Assistant reply interrupted by a server restart: unfinished, but older
    // than this runtime — no completion event will ever arrive for it, so it
    // must not block a restored queue forever.
    openCode.state.tail = [{ type: 'assistant', time: { created: 1 } }];
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].path).toBe(`/api/session/${SESSION}/prompt`);
  });

  it('treats an unreachable OpenCode as unknown, not idle', async () => {
    const { runtime, openCode, emit } = createRuntime({ retryDelayMs: () => 10 });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    openCode.state.failNext = /\/api\/session\/active$/;
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(5);
    expect(openCode.state.sent).toHaveLength(0);
    // Retried after the status fetch recovers.
    await settle(40);
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('keeps a failed item and retries with backoff', async () => {
    const { runtime, openCode, emit, broadcasts } = createRuntime({ retryDelayMs: () => 20 });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    openCode.state.failNext = /\/prompt$/;
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(10);
    expect(openCode.state.sent).toHaveLength(0);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    expect(runtime.sessionSnapshot(SESSION).sendingId).toBeNull();
    expect(broadcasts.at(-1).properties.session.sendingId).toBeNull();
    await settle(40);
    expect(openCode.state.sent).toHaveLength(1);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);
  });

  it('holds delivery briefly after a user abort', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    // v2 reports a user abort as `session.execution.interrupted`, which the
    // translator turns into an aborted `session.idle`.
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    emit({ type: 'session.idle', properties: { sessionID: SESSION, aborted: true, reason: 'user' } });
    await settle(10);
    expect(openCode.state.sent).toHaveLength(0);
    await settle(80);
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('honors a hold until it is released', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    runtime.setHold(SESSION, true, 60_000);
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    runtime.setHold(SESSION, false);
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('survives a restart and delivers once OpenCode reconnects', async () => {
    const dataDir = makeDataDir();
    const first = createRuntime({ dataDir });
    first.runtime.start();
    first.openCode.state.active = { [SESSION]: { type: 'running' } };
    await first.runtime.enqueue(SESSION, DIRECTORY, item({ content: 'persisted', text: 'persisted', contextPreview: 'Saved context preview' }));
    await first.runtime.flush();
    first.runtime.stop();

    const second = createRuntime({ dataDir });
    second.runtime.start();
    await second.runtime.load();
    expect(second.runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['persisted']);
    expect(second.runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('Saved context preview');
    second.connect();
    await settle();
    expect(second.openCode.state.sent).toHaveLength(1);
    expect(second.openCode.state.sent[0].body).toEqual({ text: 'persisted' });
  });

  it('moves an unreadable queue file aside instead of treating it as empty', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'message-queue.json'), '{ not json');
    const { runtime } = createRuntime({ dataDir });
    await runtime.load();
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('message-queue.json.corrupt-'))).toBe(true);
  });

  it('refuses to remove or take the item currently being sent', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    let release;
    // active map, message tail, the subagent check (active map, children),
    // model switch, then the prompt itself (held open until released)
    openCode.fetchImpl.mockImplementationOnce(async () => Response.json({ location: {}, data: {} }))
      .mockImplementationOnce(async () => Response.json({ data: [], cursor: {} }))
      .mockImplementationOnce(async () => Response.json({ data: {} }))
      .mockImplementationOnce(async () => Response.json({ data: [], cursor: {} }))
      .mockImplementationOnce(async () => new Response(null, { status: 204 }))
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(new Response(null, { status: 204 })); }));
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(runtime.sessionSnapshot(SESSION).sendingId).toBe(itemId);

    await expect(runtime.remove(SESSION, itemId)).rejects.toMatchObject({ status: 409 });
    await expect(runtime.take(SESSION, itemId)).rejects.toMatchObject({ status: 409 });
    const taken = await runtime.takeAll(SESSION);
    expect(taken.items).toEqual([]);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);

    release();
    await settle();
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);
  });

  it('keeps manually dispatched items until their exact acknowledgement', async () => {
    const { runtime, openCode } = createRuntime();
    openCode.state.active = { [SESSION]: { type: 'running' } };
    runtime.start();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first' }));
    const second = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'second' }));

    const dispatched = await runtime.beginManualSend(SESSION, [first.itemId, second.itemId]);
    expect(dispatched.items.map((entry) => entry.id)).toEqual([first.itemId, second.itemId]);
    expect(runtime.sessionSnapshot(SESSION)).toMatchObject({
      items: [{ id: first.itemId }, { id: second.itemId }],
      sendingIds: [first.itemId, second.itemId],
    });
    await expect(runtime.beginManualSend(SESSION, [first.itemId])).resolves.toMatchObject({ items: [] });

    await runtime.failManualSend(SESSION, [first.itemId], dispatched.token);
    expect(runtime.sessionSnapshot(SESSION)).toMatchObject({
      items: [{ id: first.itemId }, { id: second.itemId }],
      sendingIds: [second.itemId],
    });

    await runtime.ackManualSend(SESSION, [second.itemId], dispatched.token);
    expect(runtime.sessionSnapshot(SESSION)).toMatchObject({
      items: [{ id: first.itemId }],
      sendingIds: [],
    });
  });

  it('accepts a repeated manual acknowledgement after its response was lost', async () => {
    const { runtime } = createRuntime();
    runtime.start();
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item());
    const dispatched = await runtime.beginManualSend(SESSION, [itemId]);

    await runtime.ackManualSend(SESSION, [itemId], dispatched.token);
    await expect(runtime.ackManualSend(SESSION, [itemId], dispatched.token)).resolves.toMatchObject({
      session: { items: [], sendingIds: [] },
    });
  });

  it('claims only entries that are not already in flight', async () => {
    const { runtime } = createRuntime();
    runtime.start();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'in flight' }));
    const second = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'claim me' }));
    await runtime.beginManualSend(SESSION, [first.itemId]);

    const dispatched = await runtime.beginManualSend(SESSION, [first.itemId, second.itemId]);
    expect(dispatched.items.map((entry) => entry.id)).toEqual([second.itemId]);
    expect(runtime.sessionSnapshot(SESSION).sendingIds).toEqual([first.itemId, second.itemId]);
  });

  it('releases an abandoned pre-dispatch manual claim and progresses the queue', async () => {
    let timestamp = 1;
    const { runtime, openCode } = createRuntime({ now: () => timestamp });
    runtime.start();
    await runtime.load();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'abandoned' }));
    const second = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'next' }));
    const claim = await runtime.beginManualSend(SESSION, [first.itemId]);

    timestamp += 5_000;
    runtime.processPayload({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(100);

    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].body.text).toBe('follow up');
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.id)).toEqual([second.itemId]);
    expect(runtime.sessionSnapshot(SESSION).sendingIds).toEqual([]);

    await expect(runtime.startManualSend(SESSION, [first.itemId], claim.token, 'msg_abandoned')).rejects.toMatchObject({ status: 409 });
  });

  it('publishes expired unstarted ownership even when the session remains busy', async () => {
    let timestamp = 1_000;
    const { runtime, openCode, broadcasts, connect } = createRuntime({ now: () => timestamp });
    runtime.start();
    openCode.state.active = { [SESSION]: { type: 'running' } };
    const first = await runtime.enqueue(SESSION, DIRECTORY, item());
    await runtime.beginManualSend(SESSION, [first.itemId]);
    timestamp += 5_000;
    connect();
    await settle();
    expect(broadcasts.at(-1).properties.session.sendingIds).toEqual([]);
    expect(openCode.state.sent).toEqual([]);
    runtime.stop();
    await runtime.flush();
  });

  it('blocks automatic and manual delivery behind an unresolved started claim', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'protected' }));
    const second = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'next' }));
    const claim = await runtime.beginManualSend(SESSION, [first.itemId]);
    await runtime.startManualSend(SESSION, [first.itemId], claim.token, 'msg_protected');

    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent).toHaveLength(0);
    expect(runtime.sessionSnapshot(SESSION)).toMatchObject({
      items: [{ id: first.itemId }, { id: second.itemId }],
      sendingIds: [first.itemId],
    });
    const later = await runtime.beginManualSend(SESSION, [second.itemId]);
    await expect(runtime.startManualSend(SESSION, [second.itemId], later.token, 'msg_later')).rejects.toMatchObject({ status: 409 });
    runtime.stop();
  });

  it('reconciles abandonment after start using repeated idle and exact message absence, fencing a resumed browser', async () => {
    let timestamp = 1_000;
    const { runtime, openCode, connect } = createRuntime({ now: () => timestamp });
    runtime.start();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ text: 'first' }));
    const second = await runtime.enqueue(SESSION, DIRECTORY, item({ text: 'second' }));
    const ids = [first.itemId];
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, claim.token, 'msg_abandoned');
    timestamp += 60_000;
    connect();
    await settle();
    expect(runtime.sessionSnapshot(SESSION).sendingIds).toEqual(ids);
    expect(openCode.state.sent).toHaveLength(0);
    timestamp += 5_000;
    connect();
    await settle();
    expect(runtime.sessionSnapshot(SESSION).sendingIds).toEqual([]);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.id)).toEqual([first.itemId, second.itemId]);
    await expect(runtime.dispatchManualSend(SESSION, ids, claim.token, 'prompt', { id: 'msg_abandoned', text: 'first' })).rejects.toMatchObject({ status: 409 });
    connect();
    await settle();
    expect(openCode.state.sent.filter((entry) => entry.path.endsWith('/prompt')).map((entry) => entry.body.text)).toEqual(['first']);
    runtime.stop();
  });

  it('reconciles an accepted response lost to the browser without resending the exact batch', async () => {
    const { runtime, openCode, connect } = createRuntime();
    runtime.start();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item());
    const second = await runtime.enqueue(SESSION, DIRECTORY, item());
    const ids = [first.itemId, second.itemId];
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, claim.token, 'msg_accepted');
    openCode.state.tail = [{ id: 'msg_accepted', type: 'user', text: 'accepted', parts: [], time: { created: 1 } }];
    connect();
    await settle();
    expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
    expect(openCode.state.sent).toEqual([]);
    await expect(runtime.ackManualSend(SESSION, ids, claim.token)).resolves.toMatchObject({ session: { items: [] } });
    runtime.stop();
  });

  it('durably binds start to one exact identity and restores pending ownership before restart delivery', async () => {
    const first = createRuntime();
    const { runtime, dataDir } = first;
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    const ids = [queued.itemId];
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, claim.token, 'msg_restart');
    await expect(runtime.startManualSend(SESSION, ids, claim.token, 'msg_other')).rejects.toMatchObject({ status: 409 });
    await expect(runtime.startManualSend(SESSION, ids, claim.token, 'msg_restart')).resolves.toMatchObject({ token: claim.token });
    // No explicit flush: the successful start itself must wait for durability.
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'message-queue.json'), 'utf8'));
    expect(stored.sessions[SESSION].manualClaims[queued.itemId]).toMatchObject({ token: claim.token, messageID: 'msg_restart' });
    runtime.stop();
    const second = createRuntime({ dataDir });
    await second.runtime.load();
    expect(second.runtime.sessionSnapshot(SESSION).sendingIds).toEqual(ids);
    second.openCode.state.tail = [{ id: 'msg_restart', type: 'user', text: 'accepted', parts: [], time: { created: 1 } }];
    second.runtime.start();
    await settle();
    expect(second.runtime.sessionSnapshot(SESSION).items).toEqual([]);
    expect(second.openCode.state.sent).toEqual([]);
    second.runtime.stop();
  });

  it('never retries a dispatched but ambiguous claim, including after restart and idle/absent confirmations', async () => {
    let timestamp = 1_000;
    const { runtime, openCode, dataDir } = createRuntime({ now: () => timestamp });
    runtime.start();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item());
    const ids = [first.itemId];
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, claim.token, 'msg_ambiguous');
    openCode.state.failNext = /prompt$/;
    const body = { id: 'msg_ambiguous', text: 'one batch' };
    await expect(runtime.dispatchManualSend(SESSION, ids, claim.token, 'prompt', body)).rejects.toMatchObject({ status: 503 });
    await expect(runtime.failManualSend(SESSION, ids, claim.token)).rejects.toMatchObject({ status: 409 });
    runtime.stop();
    const second = createRuntime({ dataDir, openCode, now: () => timestamp });
    second.runtime.start();
    await second.runtime.load();
    timestamp += 60_000;
    second.connect();
    await settle();
    timestamp += 60_000;
    second.connect();
    await settle();
    expect(second.runtime.sessionSnapshot(SESSION).sendingIds).toEqual(ids);
    await expect(second.runtime.dispatchManualSend(SESSION, ids, claim.token, 'prompt', body)).rejects.toMatchObject({ status: 409 });
    expect(openCode.fetchImpl.mock.calls.filter(([url, init]) => init.method === 'POST' && url.includes('/prompt'))).toHaveLength(1);
    // A later authoritative record resolves the retained operation, even busy.
    openCode.state.active = { [SESSION]: { type: 'running' } };
    openCode.state.tail = [{ id: body.id, type: 'user', text: 'accepted', parts: [], time: { created: 1 } }];
    second.connect();
    await settle();
    expect(second.runtime.sessionSnapshot(SESSION).items).toEqual([]);
    second.runtime.stop();
  });

  it('forwards an exact manual batch once and rejects stale settlement against a newer owner', async () => {
    const { runtime, openCode } = createRuntime();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item());
    const ids = [first.itemId];
    const old = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, old.token, 'msg_old');
    await runtime.failManualSend(SESSION, ids, old.token);
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, claim.token, 'msg_new');
    await expect(runtime.startManualSend(SESSION, ids, old.token, 'msg_old')).rejects.toMatchObject({ status: 409 });
    await expect(runtime.failManualSend(SESSION, ids, old.token)).rejects.toMatchObject({ status: 409 });
    await expect(runtime.ackManualSend(SESSION, ids, old.token)).rejects.toMatchObject({ status: 409 });
    const body = { id: 'msg_new', text: 'full batch', files: [] };
    await runtime.dispatchManualSend(SESSION, ids, claim.token, 'prompt', body);
    expect(openCode.state.sent).toEqual([{ path: `/api/session/${SESSION}/prompt`, body }]);
    expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
    await expect(runtime.dispatchManualSend(SESSION, ids, claim.token, 'prompt', body)).rejects.toMatchObject({ status: 409 });
    expect(openCode.state.sent).toHaveLength(1);
    runtime.stop();
  });

  it('forwards a native V2 command without inventing its message identity', async () => {
    const { runtime, openCode } = createRuntime();
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item({ content: '/inspect auth' }));
    const ids = [queued.itemId];
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, claim.token, 'msg_operation');
    const body = { name: 'inspect', text: 'auth' };
    await runtime.dispatchManualSend(SESSION, ids, claim.token, 'command', body);
    expect(openCode.state.sent).toEqual([{ path: `/api/session/${SESSION}/command`, body }]);
    expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
    runtime.stop();
  });

  it('keeps the same prompt owner for the bounded definite missing-skill fallback', async () => {
    const { runtime, openCode } = createRuntime();
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    const ids = [queued.itemId];
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, claim.token, 'msg_skill');
    const body = { id: 'msg_skill', text: '/inspect auth', skills: ['skill_removed'] };
    openCode.fetchImpl.mockImplementationOnce(async () => Response.json({ _tag: 'InvalidRequestError', message: 'Skill not found: skill_removed' }, { status: 400 }));
    await expect(runtime.dispatchManualSend(SESSION, ids, claim.token, 'prompt', body)).rejects.toMatchObject({ status: 400, missingSkill: { _tag: 'InvalidRequestError' } });
    expect(runtime.sessionSnapshot(SESSION).sendingIds).toEqual(ids);
    await runtime.dispatchManualSend(SESSION, ids, claim.token, 'prompt', { id: body.id, text: 'use inspect\n/inspect auth' });
    expect(openCode.state.sent.at(-1).body).toEqual({ id: body.id, text: 'use inspect\n/inspect auth' });
    expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
    await runtime.flush();
    runtime.stop();
  });

  it('returns upstream acceptance even while queue ACK persistence is blocked', async () => {
    const { runtime, openCode } = createRuntime();
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item());
    const ids = [queued.itemId];
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, claim.token, 'msg_fast_ack');
    const rename = fs.promises.rename;
    let release = () => {};
    const ackWrite = new Promise((resolve) => { release = resolve; });
    let writes = 0;
    const delayedRename = vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      writes += 1;
      if (writes === 2) await ackWrite;
      return rename(...args);
    });
    try {
      await runtime.dispatchManualSend(SESSION, ids, claim.token, 'prompt', { id: 'msg_fast_ack', text: 'accepted' });
      expect(openCode.state.sent.at(-1).body.id).toBe('msg_fast_ack');
    } finally {
      release();
      await runtime.flush();
      delayedRename.mockRestore();
      runtime.stop();
    }
  });

  it('does not infer command acceptance from unrelated history or retry after a lost response', async () => {
    const { runtime, openCode, dataDir } = createRuntime();
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item({ content: '/inspect auth' }));
    const ids = [queued.itemId];
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, claim.token, 'msg_operation');
    openCode.state.failNext = /command$/;
    const body = { name: 'inspect', text: 'auth' };
    await expect(runtime.dispatchManualSend(SESSION, ids, claim.token, 'command', body)).rejects.toMatchObject({ status: 503 });
    runtime.stop();
    const second = createRuntime({ dataDir, openCode });
    openCode.state.tail = [{ id: 'msg_server_command', sessionID: SESSION, role: 'user' }];
    await second.runtime.load();
    second.runtime.start();
    await settle();
    expect(second.runtime.sessionSnapshot(SESSION).sendingIds).toEqual(ids);
    await expect(second.runtime.dispatchManualSend(SESSION, ids, claim.token, 'command', body)).rejects.toMatchObject({ status: 409 });
    expect(openCode.fetchImpl.mock.calls.filter(([url, init]) => init.method === 'POST' && new URL(url).pathname.endsWith('/command'))).toHaveLength(1);
    second.runtime.stop();
  });

  it('resets absence confirmation on fetch failure or busy and never treats elapsed time alone as proof', async () => {
    let timestamp = 1_000;
    const { runtime, openCode, connect } = createRuntime({ now: () => timestamp });
    runtime.start();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item());
    const ids = [first.itemId];
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, claim.token, 'msg_absent');
    connect();
    await settle();
    timestamp += 10_000;
    openCode.state.failNext = /\/message\/msg_absent$/;
    connect();
    await settle();
    timestamp += 10_000;
    connect();
    await settle();
    expect(runtime.sessionSnapshot(SESSION).sendingIds).toEqual(ids);
    openCode.state.active = { [SESSION]: { type: 'running' } };
    timestamp += 10_000;
    connect();
    await settle();
    openCode.state.active = {};
    timestamp += 10_000;
    connect();
    await settle();
    expect(runtime.sessionSnapshot(SESSION).sendingIds).toEqual(ids);
    expect(openCode.state.sent).toEqual([]);
    runtime.stop();
  });

  it('fails closed when the start operation cannot be persisted', async () => {
    const { runtime, dataDir, openCode } = createRuntime();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item());
    const ids = [first.itemId];
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.flush();
    const queuePath = path.join(dataDir, 'message-queue.json');
    fs.unlinkSync(queuePath);
    fs.mkdirSync(queuePath);
    await expect(runtime.startManualSend(SESSION, ids, claim.token, 'msg_disk')).rejects.toThrow();
    expect(openCode.state.sent).toEqual([]);
    runtime.stop();
  });

  it('releases a definitely unsent dispatch claim after its fence write recovers', async () => {
    const { runtime, dataDir, openCode } = createRuntime();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item());
    const ids = [first.itemId];
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, claim.token, 'msg_fence_write');
    const queuePath = path.join(dataDir, 'message-queue.json');
    fs.unlinkSync(queuePath);
    fs.mkdirSync(queuePath);

    await expect(runtime.dispatchManualSend(SESSION, ids, claim.token, 'prompt', {
      id: 'msg_fence_write',
      text: 'queued',
    })).rejects.toThrow();
    expect(openCode.state.sent).toEqual([]);

    fs.rmdirSync(queuePath);
    await expect(runtime.failManualSend(SESSION, ids, claim.token)).resolves.toMatchObject({
      session: { items: [{ id: first.itemId }], sendingIds: [] },
    });
    expect(openCode.state.sent).toEqual([]);
    runtime.stop();
  });

  it('does not deliver after a failed release write could restore the old claim on restart', async () => {
    const { runtime, dataDir, openCode, connect } = createRuntime();
    runtime.start();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item());
    const ids = [first.itemId];
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, claim.token, 'msg_disk_release');
    const queuePath = path.join(dataDir, 'message-queue.json');
    fs.unlinkSync(queuePath);
    fs.mkdirSync(queuePath);
    await expect(runtime.failManualSend(SESSION, ids, claim.token)).rejects.toThrow();
    connect();
    await settle();
    expect(openCode.state.sent).toEqual([]);
    runtime.stop();
  });

  it('keeps the pending head when enqueue exceeds the per-session limit', async () => {
    const { runtime } = createRuntime();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item());
    const claim = await runtime.beginManualSend(SESSION, [first.itemId]);
    await runtime.startManualSend(SESSION, [first.itemId], claim.token, 'msg_capacity');
    for (let index = 1; index < 20; index += 1) await runtime.enqueue(SESSION, DIRECTORY, item());
    await expect(runtime.enqueue(SESSION, DIRECTORY, item())).rejects.toMatchObject({ status: 409 });
    expect(runtime.sessionSnapshot(SESSION).items[0].id).toBe(first.itemId);
    runtime.stop();
    await runtime.flush();
  });

  it('reconciles after browser abandonment using only its own timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { runtime, openCode } = createRuntime();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item());
    const ids = [first.itemId];
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, claim.token, 'msg_timer');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runtime.sessionSnapshot(SESSION).sendingIds).toEqual(ids);
    await vi.advanceTimersByTimeAsync(5_000);
    await runtime.flush();
    expect(runtime.sessionSnapshot(SESSION).sendingIds).toEqual([]);
    expect(openCode.state.sent).toEqual([]);
    runtime.stop();
  });

  it('releases definite upstream rejection without affecting later queued items', async () => {
    const { runtime, openCode } = createRuntime();
    const first = await runtime.enqueue(SESSION, DIRECTORY, item());
    const second = await runtime.enqueue(SESSION, DIRECTORY, item());
    const ids = [first.itemId];
    const claim = await runtime.beginManualSend(SESSION, ids);
    await runtime.startManualSend(SESSION, ids, claim.token, 'msg_rejected');
    openCode.fetchImpl.mockImplementationOnce(async () => new Response('invalid model', { status: 400 }));
    await expect(runtime.dispatchManualSend(SESSION, ids, claim.token, 'prompt', { id: 'msg_rejected', text: 'queued' })).rejects.toMatchObject({ status: 400 });
    expect(runtime.sessionSnapshot(SESSION)).toMatchObject({ items: [{ id: first.itemId }, { id: second.itemId }], sendingIds: [] });
    runtime.stop();
  });

  it('refuses malformed version-2 operation state without overwriting it', async () => {
    const { runtime, dataDir } = createRuntime();
    const stored = { version: 2, revision: 1, sessions: { [SESSION]: { directory: DIRECTORY, items: [{ id: 'queued-stored', createdAt: 1, ...item() }] } } };
    const bytes = JSON.stringify(stored);
    const queuePath = path.join(dataDir, 'message-queue.json');
    fs.writeFileSync(queuePath, bytes);
    await expect(runtime.load()).rejects.toThrow('manual claims');
    await expect(runtime.enqueue(SESSION, DIRECTORY, item())).rejects.toThrow();
    expect(fs.readFileSync(queuePath, 'utf8')).toBe(bytes);
    runtime.stop();
  });

  it('keeps a concurrent manual claim when automatic delivery succeeds', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    let release;
    const fetch = openCode.fetchImpl.getMockImplementation();
    openCode.fetchImpl.mockImplementation((url, init) => new URL(url).pathname.endsWith('/prompt')
      ? new Promise((resolve) => { release = () => resolve(Response.json({ data: { id: 'msg_auto' } })); })
      : fetch(url, init));
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'automatic' }));
    const second = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'manual' }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    await runtime.beginManualSend(SESSION, [second.itemId]);
    release();
    await settle();

    expect(runtime.sessionSnapshot(SESSION)).toMatchObject({
      items: [{ id: second.itemId }],
      sendingIds: [second.itemId],
    });
    expect(runtime.sessionSnapshot(SESSION).items.some((entry) => entry.id === first.itemId)).toBe(false);
  });

  it('keeps a concurrent manual claim when automatic delivery fails', async () => {
    const { runtime, openCode, emit } = createRuntime({ retryDelayMs: () => 60_000 });
    runtime.start();
    let release;
    const fetch = openCode.fetchImpl.getMockImplementation();
    openCode.fetchImpl.mockImplementation((url, init) => new URL(url).pathname.endsWith('/prompt')
      ? new Promise((resolve) => { release = () => resolve(new Response('boom', { status: 500 })); })
      : fetch(url, init));
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'automatic' }));
    const second = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'manual' }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    await runtime.beginManualSend(SESSION, [second.itemId]);
    release();
    await settle();

    expect(runtime.sessionSnapshot(SESSION)).toMatchObject({
      items: [{ id: first.itemId }, { id: second.itemId }],
      sendingIds: [second.itemId],
    });
  });

  it('take hands back the full payload and leaves the rest queued', async () => {
    const { runtime } = createRuntime();
    runtime.start();
    const attachment = { id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local', dataUrl: 'data:image/png;base64,AAA=' };
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'with image', attachments: [attachment] }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain' }));

    expect(runtime.sessionSnapshot(SESSION).items[0].attachments[0]).not.toHaveProperty('dataUrl');
    const taken = await runtime.take(SESSION, first.itemId);
    expect(taken.item.attachments[0].dataUrl).toBe(attachment.dataUrl);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['plain']);

    const all = await runtime.takeAll(SESSION);
    expect(all.items.map((entry) => entry.content)).toEqual(['plain']);
    expect(runtime.snapshot().sessions).toEqual([]);
  });

  it('retains a bounded context preview in snapshots and broadcasts without exposing the full payload', async () => {
    const { runtime, broadcasts } = createRuntime();
    runtime.start();
    const context = [{ kind: 'context', text: 'Full quoted content', metadata: { openchamberContext: { kind: 'chat-quote', quote: 'Original answer', text: 'Explain this' } } }];
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context, contextPreview: 'Explain this' }));
    const projected = runtime.sessionSnapshot(SESSION).items[0];
    expect(projected.contextPreview).toBe('Explain this');
    expect(projected.content).toBe('');
    expect(projected.text).toBe('');
    expect(projected).not.toHaveProperty('context');
    expect(broadcasts.at(-1).properties.session.items[0].contextPreview).toBe('Explain this');
    const taken = await runtime.take(SESSION, itemId);
    expect(taken.item.context).toEqual(context);
    expect(taken.item.content).toBe('');

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context, contextPreview: 'a'.repeat(5000) }));
    expect(runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('a'.repeat(100) + '...');
  });

  it('derives a preview for older queued annotations without a saved summary', async () => {
    const { runtime } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context: [
      { kind: 'instruction', text: 'Use the skill' },
      { kind: 'context', text: 'Model-facing wrapper', metadata: { openchamberContext: { kind: 'browser-annotation', text: 'Fix the button\nMore detail' } } },
    ] }));
    expect(runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('Fix the button...');
  });

  it('names the directory in the broadcast that empties a queue', async () => {
    // The UI keys its projection by directory; without it the client cannot
    // tell which queue just delivered its last message and keeps showing it.
    const { runtime, emit, broadcasts, openCode } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    openCode.state.active = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent).toHaveLength(1);
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(broadcasts.at(-1).properties.session).toEqual({ sessionId: SESSION, directory: DIRECTORY, items: [], sendingId: null, sendingIds: [] });
  });

  it('reorders only with a complete permutation', async () => {
    const { runtime } = createRuntime();
    runtime.start();
    const a = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'a' }));
    const b = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'b' }));
    await expect(runtime.reorder(SESSION, [b.itemId])).rejects.toThrow(TypeError);
    await runtime.reorder(SESSION, [b.itemId, a.itemId]);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['b', 'a']);
  });

  it('drops the queue of a deleted session', async () => {
    const { runtime, emit, broadcasts } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.deleted', properties: { info: { id: SESSION } } });
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(broadcasts.at(-1).properties.session).toMatchObject({ sessionId: SESSION, items: [] });
  });

  it('dispatches a queued slash command through the command endpoint', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.commands = [{ name: 'review' }];
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '/review src', text: '/review src', sendConfig: { providerID: 'p', modelID: 'm', agent: 'build', variant: 'max' } }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].path).toBe(`/api/session/${SESSION}/command`);
    // v2's command route takes `text`, and the selection lives on the session.
    expect(openCode.state.sent[0].body).toEqual({ name: 'review', text: 'src' });
  });

  it('delivers captured context as synthetic messages, instructions first, before project knowledge', async () => {
    const knowledge = {
      resolvePendingForSession: async () => ({ text: 'pinned notes', signature: 'sig-1' }),
      recordDelivered: async () => {},
    };
    const { runtime, openCode, emit } = createRuntime({ knowledge });
    runtime.start();
    const metadata = { openchamberContext: { kind: 'github-pr', number: 7, title: 'PR', url: 'https://x/pr/7' } };
    await runtime.enqueue(SESSION, DIRECTORY, item({
      agentMention: 'reviewer',
      attachments: [{ id: 'a', filename: 'f.txt', mimeType: 'text/plain', size: 1, source: 'local', dataUrl: 'data:text/plain,hi' }],
      context: [
        { kind: 'context', text: 'the diff', metadata, instructions: 'how to read it' },
        { kind: 'synthetic', text: 'conflict payload' },
        { kind: 'instruction', text: 'use the skill' },
      ],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    // v2 has no inline synthetic parts: everything attached to the message is
    // admitted as its own synthetic message, before the prompt.
    expect(openCode.state.sent.map((entry) => entry.path)).toEqual([
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/prompt`,
    ]);
    expect(openCode.state.sent.slice(0, 5).map((entry) => entry.body)).toEqual([
      { text: 'how to read it', resume: false },
      { text: 'the diff', resume: false, metadata },
      { text: 'conflict payload', resume: false },
      { text: 'use the skill', resume: false },
      { text: 'pinned notes', resume: false },
    ]);
    expect(openCode.state.sent.at(-1).body).toEqual({
      text: 'follow up',
      files: [{ uri: 'data:text/plain,hi', name: 'f.txt' }],
      agents: [{ name: 'reviewer' }],
    });
  });

  it('keeps files on the command route, which is all that route accepts', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.commands = [{ name: 'review' }];
    await runtime.enqueue(SESSION, DIRECTORY, item({
      content: '/review',
      text: '/review',
      attachments: [{ id: 'a', filename: 'f.txt', mimeType: 'text/plain', size: 1, source: 'local', dataUrl: 'data:text/plain,hi' }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent[0].path).toBe(`/api/session/${SESSION}/command`);
    expect(openCode.state.sent[0].body).toEqual({
      name: 'review',
      text: '',
      files: [{ uri: 'data:text/plain,hi', name: 'f.txt' }],
    });
  });

  it('admits captured context as synthetic messages and still runs a queued command through the command route', async () => {
    // The command route takes attachments only, so the context goes ahead as
    // synthetic messages; the command itself keeps its route, because sending
    // "/review ..." as a prompt would skip the template OpenCode expands there.
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.commands = [{ name: 'review', description: 'Review' }];
    const metadata = { openchamberContext: { kind: 'chat-quote', quote: 'q', text: 'why?' } };
    await runtime.enqueue(SESSION, DIRECTORY, item({
      content: '/review src "error handling"',
      text: '/review src "error handling"',
      context: [{ kind: 'context', text: 'quoted', metadata }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent.map((entry) => entry.path)).toEqual([
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/command`,
    ]);
    expect(openCode.state.sent[0].body).toEqual({ text: 'quoted', resume: false, metadata });
    expect(openCode.state.sent[1].body).toEqual({ name: 'review', text: 'src "error handling"' });
  });

  it('delivers pending project knowledge ahead of a queued command and records it', async () => {
    const recorded = [];
    const knowledge = {
      resolvePendingForSession: async () => ({ text: 'pinned notes', signature: 'sig-1' }),
      recordDelivered: async (sessionId, directory, signature) => { recorded.push({ sessionId, directory, signature }); },
    };
    const { runtime, openCode, emit } = createRuntime({ knowledge });
    runtime.start();
    openCode.state.commands = [{ name: 'review' }];
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '/review', text: '/review' }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent.map((entry) => entry.path)).toEqual([
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/command`,
    ]);
    expect(openCode.state.sent[0].body).toEqual({ text: 'pinned notes', resume: false });
    expect(recorded).toEqual([{ sessionId: SESSION, directory: DIRECTORY, signature: 'sig-1' }]);
  });

  it('admits nothing when the command lookup fails, so a retry cannot duplicate the context', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.failNext = /^\/api\/command$/;
    await runtime.enqueue(SESSION, DIRECTORY, item({
      content: '/review',
      text: '/review',
      context: [{ kind: 'context', text: 'quoted', metadata: {} }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent).toEqual([]);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
  });

  it('keeps captured context out of snapshots and broadcasts, and hands it back on take', async () => {
    const { runtime, broadcasts } = createRuntime();
    runtime.start();
    const context = [{ kind: 'synthetic', text: 'a large diff' }];
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item({ context }));
    expect(runtime.sessionSnapshot(SESSION).items[0]).not.toHaveProperty('context');
    expect(runtime.sessionSnapshot(SESSION).items[0].text).toBe('follow up');
    expect(broadcasts.at(-1).properties.session.items[0]).not.toHaveProperty('context');
    const taken = await runtime.take(SESSION, itemId);
    expect(taken.item.context).toEqual(context);
  });

  it('attaches pending project knowledge and records its delivery', async () => {
    const recorded = [];
    const knowledge = {
      resolvePendingForSession: async () => ({ text: 'pinned notes', signature: 'sig-1' }),
      recordDelivered: async (sessionId, directory, signature) => { recorded.push({ sessionId, directory, signature }); },
    };
    const { runtime, openCode, emit } = createRuntime({ knowledge });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ agentMention: 'reviewer', attachments: [{ id: 'a', filename: 'f.txt', mimeType: 'text/plain', size: 1, source: 'local', dataUrl: 'data:text/plain,hi' }] }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    // Knowledge is admitted as a synthetic message ahead of the prompt.
    expect(openCode.state.sent[0].path).toBe(`/api/session/${SESSION}/synthetic`);
    expect(openCode.state.sent[0].body).toEqual({ text: 'pinned notes', resume: false });
    expect(openCode.state.sent[1].path).toBe(`/api/session/${SESSION}/prompt`);
    expect(openCode.state.sent[1].body).toEqual({
      text: 'follow up',
      files: [{ uri: 'data:text/plain,hi', name: 'f.txt' }],
      agents: [{ name: 'reviewer' }],
    });
    expect(recorded).toEqual([{ sessionId: SESSION, directory: DIRECTORY, signature: 'sig-1' }]);
  });
});
