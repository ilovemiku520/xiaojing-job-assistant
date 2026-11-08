import {mkdirSync,writeFileSync,renameSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {annotateMessages} from './message-authorship.mjs';
export function createMemoryFiles(directory){
  mkdirSync(directory,{recursive:true});
  const name=id=>createHash('sha256').update(id).digest('hex').slice(0,24);
  const atomic=(path,value)=>{writeFileSync(path+'.tmp',JSON.stringify(value,null,2),{mode:0o600});renameSync(path+'.tmp',path);};
  return {
    directory,
    save(conversation,observation=false){
      if(!conversation)return;
      const history=annotateMessages(conversation,conversation.history),window=annotateMessages(conversation,conversation.window);
      atomic(join(directory,name(conversation.peerId)+'.json'),{format:'boss-conversation/v1',...conversation,history,window,coverage:'仅包含浏览器已实际加载和观察的消息；草稿和输入不代表已经发送。站内我方不等于主人本人，作者仅按本地发送回执或主人确认标注。'});
      if(observation)appendFileSync(join(directory,'observations.jsonl'),JSON.stringify({at:Date.now(),peerId:conversation.peerId,revision:conversation.revision,messages:window})+'\n',{mode:0o600});
    },
    index(memories){atomic(join(directory,'index.json'),{format:'boss-memory-index/v1',updatedAt:Date.now(),conversations:Object.values(memories).map(c=>({peerId:c.peerId,header:c.header,file:name(c.peerId)+'.json',messages:c.history.length,lastSeenAt:c.lastSeenAt}))});}
  };
}
