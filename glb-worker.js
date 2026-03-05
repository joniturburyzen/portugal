/**
 * GLB Worker — carga con caché IndexedDB
 * Valida magic bytes antes de cachear o devolver datos
 */

const DB_NAME    = 'glb-cache';
const DB_VERSION = 1;
const STORE      = 'files';
const GLB_MAGIC  = 0x46546C67; // 'glTF' little-endian

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = e => reject(e.target.error);
  });
}

function dbGet(db, key) {
  return new Promise(resolve => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror   = () => resolve(null);
  });
}

function dbPut(db, key, value) {
  return new Promise(resolve => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror    = resolve;
  });
}

function dbDelete(db, key) {
  return new Promise(resolve => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror    = resolve;
  });
}

function isValidGLB(buffer) {
  if (buffer.byteLength < 12) return false;
  const magic = new DataView(buffer).getUint32(0, true);
  return magic === GLB_MAGIC;
}

self.onmessage = async function({ data }) {
  const { url, cacheKey } = data;

  try {
    const db = await openDB();

    // ── Intento 1: leer de caché ──────────────────────────
    const cached = await dbGet(db, cacheKey);
    if (cached) {
      if (isValidGLB(cached)) {
        self.postMessage({ type: 'cached', buffer: cached }, [cached]);
        return;
      }
      // Caché corrupta — borrarla y continuar con fetch
      await dbDelete(db, cacheKey);
    }

    // ── Intento 2: descargar ──────────────────────────────
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} — ${url}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      throw new Error(`Respuesta HTML en lugar de GLB. Verifica que el archivo está en la ruta correcta: ${url}`);
    }

    const total  = parseInt(response.headers.get('content-length') || '0');
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      self.postMessage({ type: 'progress', loaded: received, total });
    }

    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }

    if (!isValidGLB(merged.buffer)) {
      throw new Error(`El archivo descargado no es un GLB válido. Comprueba la ruta: ${url}`);
    }

    // Cachear y transferir
    dbPut(db, cacheKey, merged.buffer.slice(0));
    self.postMessage({ type: 'done', buffer: merged.buffer }, [merged.buffer]);

  } catch (err) {
    self.postMessage({ type: 'error', msg: err.message });
  }
};
