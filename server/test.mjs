import { Client } from '@colyseus/sdk';

process.env.MAX_ARENAS = '6';
process.env.ARENA_SETTLEMENT = 'test';
const settled = { opened: 0, closed: [] };
(await import('./settlement.mjs')).adapters.test = { open() { settled.opened++; }, close(arena, summary) { settled.closed.push(summary); } };
const { server } = await import('./server.mjs');
const { MAX_PLAYERS } = await import('./arenas/omega-district.mjs');

const PORT = 25670, ENDPOINT = `http://127.0.0.1:${PORT}`;
await server.listen(PORT, '127.0.0.1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const join = (district, faction) => new Client(ENDPOINT).joinOrCreate('omega.district', { district, faction });
const send = (room, x, z) => room.send('state', { x, y: 0, z, h: 0, mode: 'person' });
const placed = (room) => [...room.state.players.values()].filter((p) => p.placed);
const rejects = (p) => p.then((r) => { r.leave(); return false; }, () => true);
const quietly = (p) => Promise.race([p, sleep(1500)]);

try {
  const rooms = await Promise.all(['sol', 'lib', 'gua', 'sol'].map((f) => join(7, f)));
  check(`${MAX_PLAYERS} players matched into one district-7 arena`, new Set(rooms.map((r) => r.roomId)).size === 1);

  const fifth = await join(7, 'lib');
  check('5th player gets a new district-7 arena, not the full one', fifth.roomId !== rooms[0].roomId);
  await quietly(fifth.leave());

  rooms.forEach((r, i) => send(r, i * 10, 0));
  await sleep(400);
  const seen = rooms.map((r) => placed(r).length);
  check('every player sees all 4 in the synced state', seen.every((n) => n === 4), `counts ${seen}`);

  let patches = 0;
  rooms[0].onStateChange(() => patches++);
  for (let i = 0; i < 10; i++) { send(rooms[1], 10 + i, 0); await sleep(100); }
  check('state patches at ~10 Hz while players move', patches >= 7 && patches <= 12, `${patches}/s`);

  const p1 = () => rooms[0].state.players.get(rooms[1].sessionId).x;
  send(rooms[1], 24, 0); await sleep(250);
  send(rooms[1], 5000, 0); await sleep(250);
  check('legal move accepted, teleport refused', p1() === 24, `x=${p1()}`);

  rooms[1].send('state', { x: 24, y: 0, z: 1e9, h: 0 }); rooms[1].send('state', { x: 'NaN' }); rooms[1].send('state', null); rooms[1].send('state', 'x');
  await sleep(250);
  check('out-of-world and malformed state ignored, sender stays', p1() === 24 && rooms[1].connection.isOpen);

  rooms[1].send('junk', 1);
  await sleep(250);
  check('unknown message type disconnects the sender, arena lives on', !rooms[1].connection.isOpen && rooms[0].connection.isOpen);

  for (let i = 0; i < 100; i++) send(rooms[2], 20 + i * 0.01, 0);
  await sleep(300);
  const p2 = rooms[0].state.players.get(rooms[2].sessionId).x;
  check('message flood capped at 30/s', p2 < 20.5, `x=${p2.toFixed(2)}`);

  check('bad district rejected (string, negative, huge, missing)', (await Promise.all(['x', -1, 100000, undefined].map((d) => rejects(join(d, 'sol'))))).every(Boolean));

  const big = rooms[3];
  const closed = new Promise((r) => big.onLeave((code) => r(code)));
  big.connection.transport.ws.send(new Uint8Array(10000));
  const code = await Promise.race([closed, sleep(2000).then(() => 'open')]);
  check('oversized frame (10 KB > 4 KB) disconnects the sender', code !== 'open', `close ${code}`);
  await sleep(300);

  const other = await join(8, 'gua');
  send(other, 1, 1); await sleep(250);
  check('separate district = separate arena', other.roomId !== rooms[0].roomId && other.state.players.size === 1);

  const extra = [];
  for (let d = 100; d < 110; d++) extra.push(await join(d, 'sol').catch(() => null));
  const made = extra.filter(Boolean).length;
  check('arena limit enforced (MAX_ARENAS=6)', made < 10 && made >= 1, `${made} of 10 extra joins got an arena`);
  await Promise.all(extra.filter(Boolean).map((r) => quietly(r.leave())));

  const dropped = rooms[0], token = dropped.reconnectionToken, id = dropped.sessionId;
  dropped.reconnection.enabled = false;
  dropped.connection.transport.ws.close(3000);
  await sleep(500);
  const watcher = rooms[2];
  check('dropped player keeps their seat', watcher.connection.isOpen && watcher.state.players.has(id));
  const back = await new Client(ENDPOINT).reconnect(token);
  await sleep(250);
  check('dropped player reconnects into the same seat', back.sessionId === id && back.roomId === watcher.roomId);

  await quietly(back.leave());
  await sleep(300);
  check('a consented leave frees the seat', !watcher.state.players.has(id));

  await Promise.all([watcher, other].map((r) => quietly(r.leave())));
  await sleep(500);
  const s8 = settled.closed.find((c) => c.id === other.roomId);
  check('settlement sees arenas open and close, with an input-log hash', settled.opened >= 3 && !!s8 && s8.inputs === 1 && /^[0-9a-f]{64}$/.test(s8.logHash), `opened ${settled.opened}, closed ${settled.closed.length}, district-8 ${s8 && s8.logHash.slice(0, 12)}`);
} catch (e) {
  check('run', false, e.stack.split('\n').slice(0, 2).join(' '));
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
await quietly(server.gracefullyShutdown(false).catch(() => {}));
process.exit(results.every(Boolean) ? 0 : 1);
