// Keep only pending request identities and prompt digests in this console tab.
function createTurnRequestJournal(storageKey){
 const limit=24;
 let records=[];
 try{
  const saved=JSON.parse(sessionStorage.getItem(storageKey));
  if(Array.isArray(saved))records=saved.slice(-limit).filter(record=>
   record&&/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(record.id)&&/^[\da-f]{64}$/.test(record.digest))
   .map(({id,digest})=>({id,digest}));
 }catch{/* Storage may be disabled. Open-tab retries still work. */}
 function save(next){
  records=next.slice(-limit);
  try{sessionStorage.setItem(storageKey,JSON.stringify(records));}catch{}
 }
 const find=digest=>records.find(record=>record.digest===digest);
 return {
  get size(){return records.length;},
  async digest(mode,conversationId,prompt){
   const bytes=new TextEncoder().encode(JSON.stringify([mode,conversationId||'',prompt]));
   const hash=await crypto.subtle.digest('SHA-256',bytes);
   return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
  },
  find,
  getOrCreate(digest){
   const existing=find(digest);
   if(existing)return existing;
   const record={id:crypto.randomUUID(),digest};
   save([...records,record]);
   return record;
  },
  acknowledge(requestId){save(records.filter(record=>record.id!==requestId));}
 };
}
