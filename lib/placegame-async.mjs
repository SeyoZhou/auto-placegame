export async function mapWithConcurrency(values, limit, operation) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const value = values[next];
      next += 1;
      await operation(value);
    }
  }));
}

export function serializeCalls(operation) {
  let pending = Promise.resolve();
  return () => {
    pending = pending.then(operation);
    return pending;
  };
}
