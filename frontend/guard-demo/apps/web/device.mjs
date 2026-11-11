let devicePromise;

export function demoDevice() {
  devicePromise ??= loadDevice().catch(error => { devicePromise = undefined; throw error; });
  return devicePromise;
}

async function loadDevice() {
  const open = indexedDB.open('envoi-guard-device', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('keys');
  const db = await new Promise((resolve, reject) => {
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    // Generate outside the transaction, then read and install atomically across tabs.
    const generated = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('keys', 'readwrite');
      const store = transaction.objectStore('keys');
      const read = store.get('demo-device');
      let keys;
      read.onsuccess = () => {
        keys = read.result ?? generated;
        if (!read.result) store.add(keys, 'demo-device');
      };
      transaction.oncomplete = () => resolve(keys);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
