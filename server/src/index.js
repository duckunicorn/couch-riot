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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
