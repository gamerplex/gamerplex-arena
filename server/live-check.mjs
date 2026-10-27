import { Client } from '@colyseus/sdk';
const URL_ = process.env.ARENA_URL || 'https://arena.build.openmesh.cloud';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); };
const district = 900 + Math.floor(Math.random() * 90);
const join = (f) => new Client(URL_).joinOrCreate('omega.district', { district, faction: f });
const players = await Promise.all(['sol', 'lib', 'gua', 'sol'].map(join));
check('4 players join one live arena over WSS', new Set(players.map((p) => p.roomId)).size === 1, `district ${district}`);
players.forEach((p, i) => p.send('state', { x: i * 10, y: 0, z: 0, h: 0, mode: 'person' }));
await sleep(1200);
check('every player sees all 4', players.every((p) => [...p.state.players.values()].filter((q) => q.placed).length === 4));
const rtts = [];
for (let i = 1; i <= 8; i++) {
  const t = performance.now(), x = 10 + i;
  players[1].send('state', { x, y: 0, z: 0, h: 0, mode: 'person' });
  while (players[0].state.players.get(players[1].sessionId).x !== x && performance.now() - t < 3000) await sleep(5);
  rtts.push(performance.now() - t); await sleep(150);
}
rtts.sort((a, b) => a - b);
check('a move reaches another player', rtts[rtts.length - 1] < 3000, `median ${rtts[4].toFixed(0)} ms, range ${rtts[0].toFixed(0)}-${rtts[7].toFixed(0)} ms (Mac -> xnode-1 -> Mac, incl. up to 100 ms patch interval)`);
const d = players[3], token = d.reconnectionToken, id = d.sessionId;
d.reconnection.enabled = false; d.connection.transport.ws.close(3000);
await sleep(800);
const back = await new Client(URL_).reconnect(token);
check('dropped player reconnects into the same seat over WSS', back.sessionId === id);
await Promise.race([Promise.all([...players.slice(0, 3), back].map((p) => p.leave())), sleep(3000)]);
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
