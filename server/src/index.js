/**
 * Couch Riot relay.
 *
 * One Durable Object per 4-letter room code. The projected host screen and every
 * phone open a WebSocket to /room/<CODE>. The relay only forwards messages:
 *   phone -> host : wrapped as { from: <connection id>, data }
 *   host -> phone : host sends { to: <connection id>, data }, phone receives data
 * All game logic stays in the host page.
 *
 * Uses the WebSocket Hibernation API so idle rooms cost nothing while people talk.
 */

const CODE_RE = /^\/room\/([A-Z]{4})$/;
const SONG_RE = /^\/songs(?:\/([A-Za-z0-9_-]{1,40}))?$/;
const MAX_SONG = 20 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const songMatch = url.pathname.match(SONG_RE);
    if (songMatch) return handleSongs(request, env, songMatch[1], url);
    const match = url.pathname.match(CODE_RE);
    if (!match) {
      return new Response('Couch Riot relay is running.', { headers: { 'content-type': 'text/plain' } });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 });
    }
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    if (allowed.length && !allowed.includes(origin)) {
      return new Response('Origin not allowed.', { status: 403 });
    }
    const stub = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
    return stub.fetch(request);
  }
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    // Keepalive pings are answered without waking the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const { 0: client, 1: server } = new WebSocketPair();

    if (role === 'host') {
      const key = url.searchParams.get('key') || '';
      const savedKey = await this.ctx.storage.get('hostKey');
      const liveHosts = this.ctx.getWebSockets('host');
      if (liveHosts.length && savedKey && savedKey !== key) {
        // Someone else already hosts this code. Tell the newcomer to pick another code.
        server.accept();
        server.send(JSON.stringify({ t: '_error', error: 'id-taken' }));
        server.close(4000, 'Room code taken');
        return new Response(null, { status: 101, webSocket: client });
      }
      // Same host reconnecting (or a fresh room): replace any stale host socket.
      for (const old of liveHosts) { try { old.close(4001, 'Replaced by reconnect'); } catch {} }
      await this.ctx.storage.put('hostKey', key);
      this.ctx.acceptWebSocket(server, ['host']);
      this.broadcastPlayers({ t: '_hostback' });
    } else {
      const cid = 'c' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
      this.ctx.acceptWebSocket(server, ['player', cid]);
      if (!this.ctx.getWebSockets('host').length) server.send(JSON.stringify({ t: '_nohost' }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > 262144) return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const tags = this.ctx.getTags(ws);
    if (tags[0] === 'host') {
      if (typeof msg.to !== 'string') return;
      const payload = JSON.stringify(msg.data);
      for (const phone of this.ctx.getWebSockets(msg.to)) phone.send(payload);
    } else if (tags[0] === 'player') {
      const payload = JSON.stringify({ from: tags[1], data: msg });
      for (const host of this.ctx.getWebSockets('host')) host.send(payload);
    }
  }

  webSocketClose(ws, code, reason) {
    const tags = this.ctx.getTags(ws);
    if (tags[0] === 'player') {
      const note = JSON.stringify({ t: '_close', cid: tags[1] });
      for (const host of this.ctx.getWebSockets('host')) host.send(note);
    } else if (tags[0] === 'host' && code !== 4001) {
      const stillHosted = this.ctx.getWebSockets('host').some(h => h !== ws);
      if (!stillHosted) this.broadcastPlayers({ t: '_nohost' });
    }
    try { ws.close(code, reason); } catch {}
  }

  webSocketError(ws) {
    this.webSocketClose(ws, 1011, 'error');
  }

  broadcastPlayers(obj) {
    const payload = JSON.stringify(obj);
    for (const phone of this.ctx.getWebSockets('player')) { try { phone.send(payload); } catch {} }
  }
}

/**
 * Song library, stored in Workers KV (binding SONGS) and locked with the LIBRARY_KEY secret.
 *   GET    /songs       -> { songs: [{ id, title, by, bpm, offset, duration, ct, ts }] }
 *   PUT    /songs/:id   -> body is the audio file; title, by, bpm, offset, duration in the query string
 *   GET    /songs/:id   -> the audio file
 *   DELETE /songs/:id
 * Every request needs the header x-library-key.
 */
function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': !allowed.length ? (origin || '*') : allowed.includes(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'x-library-key, content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function sameSecret(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
async function handleSongs(request, env, id, url) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json' } });
  if (!env.SONGS) return json({ error: 'Song storage isn\'t connected to the relay yet.' }, 503);
  if (!env.LIBRARY_KEY) return json({ error: 'No library password is set on the relay yet.' }, 503);
  if (!sameSecret(request.headers.get('x-library-key') || '', env.LIBRARY_KEY)) return json({ error: 'Wrong library password.' }, 401);

  if (!id) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
    const songs = []; let cursor;
    do {
      const r = await env.SONGS.list({ prefix: 'song:', cursor });
      for (const k of r.keys) if (k.metadata) songs.push({ id: k.name.slice(5), ...k.metadata });
      cursor = r.list_complete ? null : r.cursor;
    } while (cursor);
    songs.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return json({ songs });
  }

  const key = 'song:' + id;
  if (request.method === 'GET') {
    const { value, metadata } = await env.SONGS.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!value) return json({ error: 'That song isn\'t in the library.' }, 404);
    return new Response(value, { headers: { ...cors, 'content-type': (metadata && metadata.ct) || 'application/octet-stream', 'cache-control': 'private, max-age=3600' } });
  }
  if (request.method === 'DELETE') { await env.SONGS.delete(key); return json({ ok: true }); }
  if (request.method === 'PUT') {
    if ((+request.headers.get('content-length') || 0) > MAX_SONG) return json({ error: 'That song is over 20 MB.' }, 413);
    const body = await request.arrayBuffer();
    if (!body.byteLength || body.byteLength > MAX_SONG) return json({ error: 'That song is empty or over 20 MB.' }, 413);
    const q = url.searchParams;
    const num = (k, lo, hi) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 1000) / 1000 : null; };
    const metadata = {
      title: (q.get('title') || 'Untitled').slice(0, 60), by: (q.get('by') || '').slice(0, 20),
      bpm: num('bpm', 40, 250), offset: num('offset', 0, 10), duration: num('duration', 0, 3600),
      ct: (request.headers.get('content-type') || 'application/octet-stream').slice(0, 60), ts: Date.now()
    };
    await env.SONGS.put(key, body, { metadata });
    return json({ ok: true, id, ...metadata });
  }
  return json({ error: 'Method not allowed.' }, 405);
}
