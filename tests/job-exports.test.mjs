import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateRawSync} from 'node:zlib';
import {exportJobRows,projectJobRows} from '../server/job-exports.mjs';
import {observeJobs} from '../server/jobs.mjs';

const firstSeenAt=Date.parse('2026-11-08T02:04:05.000Z');
const jobUrl=id=>'https://www.zhipin.com/job_detail/'+id+'.html';
const base={title:'游戏策划实习',company:'样例公司',city:'北京',salary:'200-250元/天',experience:'在校',description:'玩法原型与数据分析',firstSeenAt};
const profile={titles:['游戏策划'],cities:['北京'],earlyCareerOnly:true,exclusions:[]};
const state={config:{profile},jobs:{
  first:{...base,id:'fixture10',status:'ready',source:'search',url:jobUrl('one'),lastSeenAt:firstSeenAt+1000},
  favorite:{...base,id:'fixture2',status:'ready',source:'favorite',sources:['search','favorite'],url:jobUrl('two')+'?securityId=do-not-export',sourcePage:'https://www.zhipin.com/web/geek/recommend?securityId=do-not-export',description:'玩法原型、Unity 与关卡脚本',lastSeenAt:firstSeenAt+5000,detailObservedAt:firstSeenAt+9000,lease:'DO_NOT_EXPORT_LEASE',peerId:'DO_NOT_EXPORT_PEER'},
  senior:{...base,id:'senior',status:'ready',title:'高级游戏策划',experience:'5-10年',url:jobUrl('senior'),lastSeenAt:firstSeenAt},
  pending:{...base,id:'pending',status:'listed',description:'',url:jobUrl('pending')},
  invalid:{...base,id:'unsafe',status:'ready',url:'javascript:alert(1)'},
}};

function zipParts(buffer){
  const files=new Map();
  let offset=0;
  while(buffer.readUInt32LE(offset)===0x04034b50){
    assert.equal(buffer.readUInt16LE(offset+8),8);
    const length=buffer.readUInt32LE(offset+18);
    const expected=buffer.readUInt32LE(offset+22);
    const nameSize=buffer.readUInt16LE(offset+26),nameEnd=offset+30+nameSize;
    const name=buffer.toString('utf8',offset+30,nameEnd);
    const start=nameEnd+buffer.readUInt16LE(offset+28);
    const bytes=inflateRawSync(buffer.subarray(start,start+length));
    assert.equal(bytes.length,expected);
    files.set(name,bytes.toString('utf8'));
    offset=start+length;
  }
  assert.equal(buffer.readUInt32LE(offset),0x02014b50);
  assert.equal(buffer.readUInt32LE(buffer.length-22),0x06054b50);
  return files;
}

test('岗位表与导出共用字段、筛选、匹配判断和可复现的排序',()=>{
  const rows=projectJobRows(state);
  assert.deepEqual(rows.map(row=>row.id),['fixture2','fixture10','senior','pending']);
  assert.deepEqual(rows.map(row=>row.fit),['matched','matched','unmatched','unverified']);
  assert.deepEqual(rows[0].sources,['favorite','search']);
  assert.equal(rows[0].url,jobUrl('two'));
  assert.equal(rows[0].sourcePage,'https://www.zhipin.com/web/geek/recommend');
  assert.equal(rows[0].detailObservedAt,firstSeenAt+9000);
  assert.equal(rows[3].lastSeenAt,null);
  assert(!JSON.stringify(rows).includes('DO_NOT_EXPORT'));
  assert.deepEqual(projectJobRows(state,{q:'北京 unity',source:'favorite',fit:'matched',status:'ready'}).map(row=>row.id),['fixture2']);
  assert.deepEqual(projectJobRows(state,{query:'Unity',source:'search'}).map(row=>row.id),['fixture2']);
  assert.deepEqual(projectJobRows(state,{sort:'lastSeenAt',direction:'asc'}).map(row=>row.id),['pending','senior','fixture10','fixture2']);
  assert.deepEqual(projectJobRows(state,{sort:'title',direction:'asc',fit:'matched'}).map(row=>row.id),['fixture2','fixture10']);
  assert.throws(()=>projectJobRows(state,{sort:'lease'}),/排序/);
});

test('月薪匹配读取完整金额和单位，岗位表及筛选导出保留原薪资标签',()=>{
  const cases=[
    ['10–12K','matched'],['12K-16K','matched'],['12-16Ｋ·13薪','matched'],['12,000–15,000元/月','matched'],['15K','matched'],
    ['6–10.5K','unmatched'],['18K/月','unmatched'],['12-16K/年','unverified'],['200-250元/天','unverified'],
    ['16-12K','unverified'],['仅展示 12-16K','unverified'],['面议','unverified'],
  ];
  const jobs=Object.fromEntries(cases.map(([salary],index)=>[index,{...base,id:String(index),status:'ready',url:jobUrl('salary'+index),salary}]));
  const scoped={config:{profile:{...profile,salaryMin:11,salaryMax:16}},jobs};
  const rows=projectJobRows(scoped);
  assert.deepEqual(cases.map(([label])=>rows.find(row=>row.salary===label)?.fit),cases.map(([,fit])=>fit));
  const {jobs:exported}=JSON.parse(exportJobRows(projectJobRows(scoped,{fit:'matched'}),'json').body);
  assert.deepEqual(exported.map(row=>row.salary).sort(),cases.filter(([,fit])=>fit==='matched').map(([label])=>label).sort());
  assert.equal(projectJobRows({config:{profile},jobs}).every(row=>row.fit==='matched'),true,'薪资不限时保留各种薪资展示');
});

test('CSV 包含 UTF-8 BOM、正确引用及持久公式防护，JSON 保留精确数据类型',()=>{
  const harmful='\u200b=HYPERLINK("https://unsafe.example/","按钮")';
  const rows=projectJobRows({config:{profile},jobs:{sample:{...base,id:'00123456789012345678',status:'ready',url:jobUrl('sample'),title:harmful,description:'逗号, 引号"\n下一行'}}});
  const csv=exportJobRows(rows,'csv',{generatedAt:firstSeenAt});
  assert.equal(csv.contentType,'text/csv; charset=utf-8');
  assert.deepEqual([...csv.body.subarray(0,3)],[0xef,0xbb,0xbf]);
  assert.match(csv.body.toString(),/文本：\u200b=HYPERLINK\(""https:\/\/unsafe\.example\/"",""按钮""\)/);
  assert.match(csv.body.toString(),/"逗号, 引号""\n下一行"/);
  assert.match(csv.body.toString(),/"2026-11-08T10:04:05\.000\+08:00"/);
  const json=JSON.parse(exportJobRows(rows,'json',{generatedAt:firstSeenAt}).body.toString());
  assert.equal(json.jobs[0].title,harmful);
  assert.equal(json.jobs[0].id,'00123456789012345678');
  assert.equal(json.jobs[0].firstSeenAt,firstSeenAt);
  assert.equal(json.total,1);
  assert.equal(json.generatedAt,'2026-11-08T02:04:05.000Z');
});

test('XLSX 是可解包工作簿，日期为数值，外链经过投影且网页字段始终为文本',()=>{
  const rows=projectJobRows({config:{profile},jobs:{sample:{...base,id:'00123456789012345678',status:'ready',url:jobUrl('sample')+'?token=fixture',title:'=1+1 <岗位> _x0041_\u0000'}}});
  const xlsx=exportJobRows(rows,'xlsx',{generatedAt:firstSeenAt});
  assert.equal(xlsx.extension,'xlsx');
  const files=zipParts(xlsx.body),sheet=files.get('xl/worksheets/sheet1.xml');
  assert.match(files.get('xl/workbook.xml'),/<sheet name="岗位列表"/);
  assert.match(sheet,/<autoFilter ref="A1:S2"\/>/);
  assert.match(sheet,/<pane ySplit="1"/);
  assert.match(sheet,/<c r="A2" s="0" t="inlineStr"><is><t xml:space="preserve">=1\+1 &lt;岗位&gt; _x005F_x0041_<\/t>/);
  assert(!sheet.includes('\u0000'));
  assert(!sheet.includes('<f'));
  const date=Number(sheet.match(/<c r="K2" s="2"><v>([0-9.]+)<\/v>/)?.[1]);
  assert(Math.abs(date-((firstSeenAt+28800000)/86400000+25569))<0.0000001);
  assert.match(files.get('xl/styles.xml'),/formatCode="yyyy-mm-dd hh:mm"/);
  assert.match(files.get('xl/worksheets/_rels/sheet1.xml.rels'),/Target="https:\/\/www\.zhipin\.com\/job_detail\/sample\.html" TargetMode="External"/);
  assert(!Array.from(files.values()).some(value=>value.includes('token=fixture')));
  assert.match( files.get('docProps/core.xml'), /2026-11-08T02:04:05\.000Z/);
  assert.match(zipParts(exportJobRows([],'xlsx').body).get('xl/worksheets/sheet1.xml'),/<autoFilter ref="A1:S1"\/>/);
});

test('已观察收藏路径保留允许的路由参数，普通搜索和旧路径不补造收藏链接',()=>{
  const origin='https://www.zhipin.com',recommend=origin+'/web/geek/recommend';
  const route=recommend+'?tab=4&sub=1&page=2&tag=4';
  const raw=recommend+'?tag=4&securityId=fixture-sensitive&page=2&tab=4&sub=1&session=fixture-session#private';
  const observed={config:{profile},jobs:{}};
  const favorite={...base,url:jobUrl('favorite-route')},search={...base,url:jobUrl('search-route')};
  const [id]=observeJobs(observed,[favorite],{source:'favorite',page:raw,now:firstSeenAt});
  assert.equal(observed.jobs[id].favoriteSourcePage,route);
  observeJobs(observed,[favorite],{source:'favorite',page:recommend,now:firstSeenAt+1});
  assert.equal(observed.jobs[id].favoriteSourcePage,route,'路径级历史来源不会擦除已核对的收藏入口');
  observeJobs(observed,[favorite],{source:'search',page:origin+'/web/geek/job?securityId=fixture-sensitive',now:firstSeenAt+2});
  const [searchId]=observeJobs(observed,[{...search,favoriteSourcePage:raw}],{source:'search',page:raw,now:firstSeenAt+3});
  const rows=projectJobRows(observed),byId=Object.fromEntries(rows.map(row=>[row.id,row]));
  assert.deepEqual(byId[id].sources,['favorite','search']);assert.equal(byId[id].sourcePage,route);
  assert.deepEqual(byId[searchId].sources,['search']);assert.equal(byId[searchId].sourcePage,recommend);
  assert.doesNotMatch(JSON.stringify(observed.jobs),/fixture-sensitive|fixture-session|#private/);
  const relationship=zipParts(exportJobRows([byId[id]],'xlsx').body).get('xl/worksheets/_rels/sheet1.xml.rels');
  assert(relationship.includes(`Target="${route.replaceAll('&','&amp;')}" TargetMode="External"`));
  assert.doesNotMatch(relationship,/securityId|session|private/);
  for(const query of ['', '?tab=3&sub=1', '?tab=4&page=0', '?tab=4&page=1&page=2', '?tab=4&sub=token', '?tab=4&tag=9999999']){
    const legacy={...favorite,id:'legacy',source:'favorite',favoriteSourcePage:recommend+query};
    assert.equal(projectJobRows({jobs:{legacy}})[0].sourcePage,recommend,query);
  }
});
