// Where an arena's lifecycle goes. 'none' today; an 'er' adapter will open/finish/commit through the Arena program (src/arena-client.ts).
export const adapters = {
  none: { open() {}, close() {} },
};

export const settlement = (name = process.env.ARENA_SETTLEMENT || 'none') => {
  const a = adapters[name];
  if (!a) throw new Error(`unknown settlement: ${name}`);
  return a;
};
