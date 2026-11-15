/* Shared device-local session store. No networking, analytics or dependencies.
 * Vendored byte-for-byte by Breathe and Harmony. */
(() => {
  class LocalSessionStore {
    constructor(namespace, {retentionDays = 14, maxBytes = 104857600} = {}) {
      this.retentionMs = retentionDays * 86400000; this.maxBytes = maxBytes;
      this.db = new Promise((resolve,reject) => {
        const r = indexedDB.open(namespace, 2);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains('sessions')) r.result.createObjectStore('sessions',{keyPath:'id'});
          if (!r.result.objectStoreNames.contains('chunks')) r.result.createObjectStore('chunks',{keyPath:'id'}).createIndex('session','session');
        };
        r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
      });
    }
    async rows() {
      const db=await this.db;
      return new Promise((resolve,reject)=>{const r=db.transaction('sessions').objectStore('sessions').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    }
    async write(row, remove=false, chunk=null) {
      const db=await this.db;
      return new Promise((resolve,reject)=>{
        const tx=db.transaction(['sessions','chunks'],'readwrite'),s=tx.objectStore('sessions'),c=tx.objectStore('chunks');
        if(remove){s.delete(row.id);const r=c.index('session').openKeyCursor(IDBKeyRange.only(row.id));r.onsuccess=()=>{const cursor=r.result;if(cursor){c.delete(cursor.primaryKey);cursor.continue();}};}
        else {s.put(row);if(chunk)c.put(chunk);}
        tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
    }
    async audio(row) {
      if(row.blob)return row.blob;
      const db=await this.db;
      return new Promise((resolve,reject)=>{const r=db.transaction('chunks').objectStore('chunks').index('session').getAll(row.id);r.onsuccess=()=>resolve(new Blob(r.result.sort((a,b)=>a.index-b.index).map(x=>x.blob),{type:row.mimeType}));r.onerror=()=>reject(r.error);});
    }
    async prune() {
      const rows=await this.rows(), cutoff=Date.now()-this.retentionMs;
      let remaining=[];
      for(const row of rows){if(!row.keep&&row.started<cutoff)await this.write(row,true);else remaining.push(row);}
      // Keep is never auto-deleted. The cap applies to unpinned data only.
      const pinnedBytes=remaining.filter(r=>r.keep).reduce((n,r)=>n+(r.bytes||0),0);
      const unpinned=remaining.filter(r=>!r.keep).sort((a,b)=>a.started-b.started);
      let unpinnedBytes=unpinned.reduce((n,r)=>n+(r.bytes||0),0);
      for(const row of unpinned){if(unpinnedBytes<=this.maxBytes)break;await this.write(row,true);unpinnedBytes-=row.bytes||0;}
      return {bytes:pinnedBytes+unpinnedBytes,pinnedBytes,unpinnedBytes,maxBytes:this.maxBytes,full:pinnedBytes>=this.maxBytes};
    }
  }
  globalThis.LocalSessionStore=LocalSessionStore;
})();
