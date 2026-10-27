#!/usr/bin/env node
import { defineServer, defineRoom } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { OmegaDistrict } from './arenas/omega-district.mjs';

export const server = defineServer({
  transport: new WebSocketTransport({ maxPayload: 4096, pingInterval: 5000, pingMaxRetries: 3 }),
  rooms: { 'omega.district': defineRoom(OmegaDistrict).filterBy(['district']) },
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = +process.env.PORT || 2567;
  await server.listen(port, process.env.HOST || '0.0.0.0');
  console.log(`[arena-server] listening on :${port}`);
}
