import { createHash } from 'node:crypto';
import { Room } from '@colyseus/core';
import { settlement } from './settlement.mjs';

export const MAX_ARENAS = +process.env.MAX_ARENAS || 200;
let live = 0;

// Base for every arena type: arena cap, an input-log hash, and open/close to settlement.
export class Arena extends Room {
  onCreate() {
    if (live >= MAX_ARENAS) throw new Error('arena limit reached');
    live++;
    this.counted = true;
    this.log = createHash('sha256');
    this.inputs = 0;
    this.settle = settlement();
    this.settle.open(this);
  }

  record(sessionId, input) {
    this.log.update(JSON.stringify([this.inputs++, sessionId, input]));
  }

  summary(result = null) {
    return { type: this.roomName, id: this.roomId, inputs: this.inputs, logHash: this.log.copy().digest('hex'), result };
  }

  onDispose() {
    if (!this.counted) return;
    live--;
    this.settle.close(this, this.summary(this.result ?? null));
  }
}
