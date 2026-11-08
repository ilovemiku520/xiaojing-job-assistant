import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
const localKnowledge=fileURLToPath(new URL('../knowledge/',import.meta.url));
const starterKnowledge=fileURLToPath(new URL('../desktop/starter/',import.meta.url));
export const knowledgeDir=resolve(process.env.BOSS_KNOWLEDGE_DIR||(existsSync(localKnowledge)?localKnowledge:starterKnowledge));
export function loadKnowledge(dir=knowledgeDir){
  const persona=readFileSync(join(dir,'12_人格与主人权限.txt'),'utf8');
  const identity=JSON.parse(readFileSync(join(dir,'13_机器人与主人记忆.json'),'utf8'));
  const rule=persona+'\n\n'+readFileSync(join(dir,'01_系统规则.txt'),'utf8');
  const files=['02_个人事实.json','03_求职偏好.json','04_项目与游戏记忆.json'];
  const [candidate,preferences,projects]=files.map(f=>JSON.parse(readFileSync(join(dir,f),'utf8')));
  return {rule,identity,candidate,preferences,projects};
}
