import { Arena } from '../arena.mjs';
import { schema, t } from '@colyseus/schema';

export const MAX_PLAYERS = 4, MAX_SPEED = 60, RECONNECT_S = 15, MAX_DISTRICT = 999, WORLD = 50000, MAX_MSGS_PER_S = 30;
const FACTIONS = ['sol', 'lib', 'gua'];
const MODES = ['person', 'car', 'cyclist', 'helicopter'];

const Player = schema({ faction: t.string(), x: t.number(), y: t.number(), z: t.number(), h: t.number(), mode: t.string(), placed: t.boolean() }, 'Player');
const DistrictState = schema({ district: t.uint16(), players: t.map(Player) }, 'DistrictState');

export const districtOf = (v) => {
  const d = Number(v);
  if (!Number.isInteger(d) || d < 0 || d > MAX_DISTRICT) throw new Error('bad district');
  return d;
};

const inWorld = (m) => [m.x, m.y, m.z, m.h].every(Number.isFinite) && Math.abs(m.x) <= WORLD && Math.abs(m.z) <= WORLD && m.y >= -1000 && m.y <= 5000;

export class OmegaDistrict extends Arena {
  maxClients = MAX_PLAYERS;
  state = new DistrictState();

  onCreate(options) {
    const district = districtOf(options?.district);
    super.onCreate();
    this.state.district = district;
    this.setPatchRate(100);
    this.seen = new Map();
    this.onMessage('state', (client, m) => {
      const p = this.state.players.get(client.sessionId), s = this.seen.get(client.sessionId);
      if (!p || !s || !m || typeof m !== 'object') return;
      const now = Date.now();
      if (now - s.window >= 1000) { s.window = now; s.count = 0; }
      if (++s.count > MAX_MSGS_PER_S || !inWorld(m)) return;
      const dt = Math.max(0.05, (now - (s.at || now)) / 1000);
      if (p.placed && Math.hypot(m.x - p.x, m.z - p.z) > MAX_SPEED * dt + 5) return;
      const input = { x: m.x, y: m.y, z: m.z, h: m.h, mode: MODES.includes(m.mode) ? m.mode : 'person' };
      Object.assign(p, input, { placed: true });
      this.record(client.sessionId, input);
      s.at = now;
    });
  }

  onJoin(client, options) {
    if (districtOf(options?.district) !== this.state.district) throw new Error('wrong district');
    const faction = FACTIONS.includes(options?.faction) ? options.faction : 'sol';
    this.state.players.set(client.sessionId, new Player({ faction, x: 0, y: 0, z: 0, h: 0, mode: 'person', placed: false }));
    this.seen.set(client.sessionId, { at: 0, window: 0, count: 0 });
  }

  async onDrop(client) {
    await this.allowReconnection(client, RECONNECT_S).catch(() => this.drop(client.sessionId));
  }

  onLeave(client) { this.drop(client.sessionId); }

  drop(id) { this.state.players.delete(id); this.seen.delete(id); }
}
