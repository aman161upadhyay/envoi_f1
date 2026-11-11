export function localSealer(publicRecord) {
  return {
    async tip() {
      let batchId = 0;
      let root = '0'.repeat(64);
      for (;;) {
        const next = await publicRecord.readRoot(batchId + 1);
        if (!next) return { batchId, root };
        batchId++;
        root = next.root;
      }
    },
    async prepare(batch) { return { batchId: batch.id, root: batch.root }; },
    async broadcast(submission, batch) {
      const existing = await publicRecord.readRoot(batch.id);
      if (!existing) await publicRecord.seal({
        batchId: batch.id, root: batch.root, previousRoot: batch.previous_root, count: batch.count
      });
    },
    async inspect(submission, batch) {
      const root = await publicRecord.readRoot(batch.id);
      if (!root) return { status: 'missing' };
      if (root.root !== batch.root || root.previousRoot !== batch.previous_root || root.count !== batch.count) {
        return { status: 'conflict', detail: 'The local public record contains a different batch.' };
      }
      return await publicRecord.status(root.txRef) === 'final' ? { status: 'final', txRef: root.txRef } : { status: 'pending' };
    }
  };
}
