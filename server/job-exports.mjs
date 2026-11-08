import {deflateRawSync} from 'node:zlib';
import {clean} from './control.mjs';
import {favoriteSourceURL,jobURL,matchJob} from './job-match.mjs';
import {emptyJobProgress} from './job-progress.mjs';

const sourceLabels={favorite:'收藏',search:'搜索'};
const statusLabels={listed:'等待读取',reading:'正在读取',ready:'已读详情',needs_adaptation:'待校准'};
const fitLabels={matched:'符合筛选',unmatched:'不符合筛选',unverified:'待核对'};
const stageLabels={unobserved:'暂无跟进记录',contacted:'有历史沟通',message_sent:'消息已确认发送',resume_sent:'简历已确认发送',pending:'待处理',sending:'发送中',receipt_uncertain:'发送结果待核对'};
const sourceKeys=Object.keys(sourceLabels);
const statusKeys=Object.keys(statusLabels);
const fitKeys=Object.keys(fitLabels);
const dateKeys=['firstSeenAt','lastSeenAt','detailObservedAt'];
const sortKeys=['title','company','city','salary','experience','source','status','fit','stage',...dateKeys];
const collator=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
const safeText=(value,max=1000)=>typeof value==='string'?clean(value).slice(0,max):'';
const timestamp=value=>Number.isSafeInteger(value)&&value>0&&value<=253402271999999?value:null;

function sourcePage(value){
  try{
    const url=new URL(value);
    if(url.origin==='https://www.zhipin.com'&&/^\/web\/geek\/(?:job|jobs|recommend)\/?$/.test(url.pathname))return url.origin+url.pathname;
  }catch{}
  return '';
}

function fitFor(job,profile){
  if(!profile?.titles?.length||!profile?.cities?.length)return {fit:'unverified',matchReason:'尚未配置岗位及城市筛选条件'};
  if(!job.title||!job.company||!job.city)return {fit:'unverified',matchReason:'岗位、公司或城市待核对'};
  const matchReason=matchJob(job,{...profile,exclusions:profile.exclusions||[]});
  if(matchReason)return {fit:/不明确|未确认/.test(matchReason)?'unverified':'unmatched',matchReason};
  return job.status==='ready'?{fit:'matched',matchReason:''}:{fit:'unverified',matchReason:'详情待核对'};
}

export function filterJobRows(rows,{q,query='',source='all',status='all',fit='all',stage='all',sort='lastSeenAt',direction='desc'}={}){
  const terms=String(q??query).trim().toLocaleLowerCase('zh-CN').split(/\s+/u).filter(Boolean);
  if(!['all',...sourceKeys].includes(source)||!['all',...statusKeys].includes(status)||!['all',...fitKeys].includes(fit)||stage!=='all'&&!Object.hasOwn(stageLabels,stage))throw Error('岗位筛选参数无效');
  if(!sortKeys.includes(sort)||!['asc','desc'].includes(direction))throw Error('岗位排序参数无效');
  const selected=rows.filter(row=>{
    if(source!=='all'&&!row.sources.includes(source)||status!=='all'&&status!==row.status||fit!=='all'&&fit!==row.fit||stage!=='all'&&stage!==(row.progress||emptyJobProgress).status)return false;
    if(!terms.length)return true;
    const haystack=[row.title,row.company,row.city,row.salary,row.experience,row.description].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
    return terms.every(term=>haystack.includes(term));
  });
  const sign=direction==='asc'?1:-1;
  const sortValue=row=>sort==='stage'?stageLabels[(row.progress||emptyJobProgress).status]:row[sort];
  const compare=dateKeys.includes(sort)
    ?(a,b)=>(a[sort]||0)-(b[sort]||0)
    :(a,b)=>collator.compare(sortValue(a)||'',sortValue(b)||'');
  return selected.sort((a,b)=>sign*compare(a,b)||(b.lastSeenAt||0)-(a.lastSeenAt||0)||collator.compare(a.id,b.id)||collator.compare(a.url,b.url));
}

export function pageJobRows(rows,options){
  const page=Number(options.page),pageSize=Number(options.pageSize??25);
  if(!Number.isSafeInteger(page)||page<1||![25,50,100].includes(pageSize))throw Error('岗位分页参数无效');
  const selected=filterJobRows(rows,options);
  const counts={all:rows.length,favorite:0,search:0};
  for(const row of rows)for(const source of row.sources)counts[source]++;
  const pages=Math.max(1,Math.ceil(selected.length/pageSize));
  const currentPage=Math.min(page,pages);
  const offset=(currentPage-1)*pageSize;
  const summaries=selected.slice(offset,offset+pageSize).map(({id,title,company,city,salary,experience,sources,status,fit,lastSeenAt,progress,url})=>({
    id,title,company,city,salary,experience,sources,status,fit,lastSeenAt,progress,url
  }));
  return {rows:summaries,total:selected.length,counts,page:currentPage,pages,offset};
}

export function projectJobRows(state,filters,progress={}){
  const profile=state.config?.profile;
  const rows=[];
  for(const job of Object.values(state.jobs||{})){
    if(!job||typeof job!=='object')continue;
    let url;
    try{url=jobURL(job.url);}catch{continue;}
    const sources=sourceKeys.filter(value=>job.source===value||(Array.isArray(job.sources)&&job.sources.includes(value))||value==='favorite'&&job.favorite===true);
    if(!sources.length)sources.push('search');
    const id=safeText(job.id,120);
    const collectionPage=sources.includes('favorite')?favoriteSourceURL(job.favoriteSourcePage):'';
    const row={
      id,title:safeText(job.title),company:safeText(job.company),city:safeText(job.city),
      salary:safeText(job.salary),experience:safeText(job.experience),source:sources[0],sources,
      status:statusKeys.includes(job.status)?job.status:'listed',...fitFor(job,profile),
      description:safeText(job.description,16000),url,sourcePage:collectionPage||sourcePage(job.sourcePage||job.favoriteSourcePage),
      firstSeenAt:timestamp(job.firstSeenAt),lastSeenAt:timestamp(job.lastSeenAt),detailObservedAt:timestamp(job.detailObservedAt),
      progress:Object.hasOwn(progress,id)?progress[id]:emptyJobProgress,
    };
    rows.push(row);
  }
  return filterJobRows(rows,filters);
}

const columns=[
  {key:'title',label:'岗位',width:33},
  {key:'company',label:'公司',width:24},
  {key:'city',label:'城市',width:12},
  {key:'salary',label:'薪资',width:14},
  {key:'experience',label:'经验要求',width:15},
  {key:'sources',label:'来源',width:13,value:row=>row.sources.map(value=>sourceLabels[value]).join('、')},
  {key:'status',label:'采集状态',width:15,value:row=>statusLabels[row.status]},
  {key:'fit',label:'匹配状态',width:15,value:row=>fitLabels[row.fit]},
  {key:'matchReason',label:'筛选说明',width:34},
  {key:'url',label:'岗位链接',width:17,link:true},
  {key:'firstSeenAt',label:'首次发现（北京）',width:23,date:true},
  {key:'lastSeenAt',label:'最近发现（北京）',width:23,date:true},
  {key:'detailObservedAt',label:'详情采集（北京）',width:23,date:true},
  {key:'description',label:'岗位详情',width:76,wrap:true},
  {key:'sourcePage',label:'来源页面',width:17,link:true},
  {key:'id',label:'岗位 ID',width:28},
  {key:'stage',label:'跟进状态',width:24,value:row=>stageLabels[(row.progress||emptyJobProgress).status]},
  {key:'progressAt',label:'进展记录（北京）',width:23,date:true,value:row=>row.progress?.at??null},
  {key:'resumeConfirmed',label:'简历发送确认',width:20,value:row=>row.progress?.resume==='confirmed'?'已确认':'暂无确认'},
];
const valueAt=(column,row)=>column.value?column.value(row):row[column.key];
const beijingOffset=8*60*60*1000;
const excelDate=value=>(value+beijingOffset)/86400000+25569;
const csvDate=value=>value===null?'':new Date(value+beijingOffset).toISOString().replace('Z','+08:00');
const xmlDeclaration='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const spreadsheetNs='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const packageNs='http://schemas.openxmlformats.org/package/2006/relationships';
const relNs='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const contentTypeNs='http://schemas.openxmlformats.org/package/2006/content-types';

function csvCell(value){
  let text=String(value??'');
  // A visible neutral prefix survives spreadsheet save/reopen. Exact text
  // remains available in JSON and in the typed text cells of the XLSX file.
  if(/^[\t\r\n]|^[\s'\u200b-\u200f\u2060\ufeff]*[=+\-@＝＋－＠]/u.test(text))text='文本：'+text;
  return '"'+text.replaceAll('"','""')+'"';
}

function csv(rows){
  const lines=[columns.map(column=>csvCell(column.label)).join(',')];
  for(const row of rows)lines.push(columns.map(column=>{
    const value=valueAt(column,row);
    return csvCell(column.date?csvDate(value):value);
  }).join(','));
  return '\ufeff'+lines.join('\r\n')+'\r\n';
}

function xml(value){
  return String(value??'')
    .replace(/_x[\da-f]{4}_/gi,match=>'_x005F_'+match.slice(1))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'')
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&apos;");
}

const crcTable=Uint32Array.from({length:256},(_,value)=>{
  let remainder=value;
  for(let bit=0;bit<8;bit++)remainder=(remainder>>>1)^((remainder&1)?0xedb88320:0);
  return remainder;
});
function crc32(data){
  let value=0xffffffff;
  for(const byte of data)value=(value>>>8)^crcTable[(value^byte)&255];
  return (value^0xffffffff)>>>0;
}

function zip(entries){
  const files=[],directory=[];
  let offset=0,directoryLength=0;
  for(const [filename,content] of entries){
    const name=Buffer.from(filename),data=Buffer.from(content),compressed=deflateRawSync(data),checksum=crc32(data);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);
    local.writeUInt16LE(20,4);
    local.writeUInt16LE(8,8); // raw DEFLATE
    local.writeUInt16LE(33,12); // fixed DOS date, 1980-01-01
    local.writeUInt32LE(checksum,14);
    local.writeUInt32LE(compressed.length,18);
    local.writeUInt32LE(data.length,22);
    local.writeUInt16LE(name.length,26);
    const central=Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0);
    central.writeUInt16LE(20,4);
    local.copy(central,6,4,28);
    central.writeUInt32LE(offset,42);
    files.push(local,name,compressed);
    directory.push(central,name);
    offset+=local.length+name.length+compressed.length;
    directoryLength+=central.length+name.length;
  }
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(entries.length,8);
  end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(directoryLength,12);
  end.writeUInt32LE(offset,16);
  return Buffer.concat([...files,...directory,end]);
}

const inline=(cell,value,style)=>`<c r="${cell}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
const letter=index=>String.fromCharCode(65+index);
const relationships=items=>xmlDeclaration+`<Relationships xmlns="${packageNs}">`+items.map(item=>`<Relationship Id="${item.id}" Type="${relNs}/${item.type}" Target="${xml(item.target)}"${item.external?' TargetMode="External"':''}/>`).join('')+'</Relationships>';
const styles=xmlDeclaration+`<styleSheet xmlns="${spreadsheetNs}">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>
  <fonts count="3">
    <font><sz val="11"/><color rgb="FF183534"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font>
    <font><u/><sz val="11"/><color rgb="FF006968"/><name val="Microsoft YaHei"/></font>
  </fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF245453"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left/><right/><top/><bottom style="thin"><color rgb="FFE6EEEB"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function xlsx(rows,generatedAt){
  if(rows.length>=1048576)throw Error('Excel 岗位记录超过单表容量，请按筛选条件分批导出');
  const links=[],hyperlinks=[];
  const header=columns.map((column,index)=>inline(letter(index)+'1',column.label,1)).join('');
  const sheetRows=[`<row r="1" ht="26" customHeight="1">${header}</row>`];
  for(const [index,row] of rows.entries()){
    const number=index+2;
    const cells=columns.map((column,col)=>{
      const cell=letter(col)+number,value=valueAt(column,row);
      if(column.date&&value!==null)return `<c r="${cell}" s="2"><v>${excelDate(value)}</v></c>`;
      if(column.link&&value){
        const id='rId'+(links.length+1);
        links.push({id,type:'hyperlink',target:value,external:true});
        hyperlinks.push(`<hyperlink ref="${cell}" r:id="${id}"/>`);
        return inline(cell,column.key==='url'?'打开岗位':'查看来源',3);
      }
      return inline(cell,value,column.wrap?4:0);
    }).join('');
    sheetRows.push(`<row r="${number}" ht="27" customHeight="1">${cells}</row>`);
  }
  const dataRange='A1:'+letter(columns.length-1)+(rows.length+1);
  const widths=columns.map((column,index)=>`<col min="${index+1}" max="${index+1}" width="${column.width}" customWidth="1"/>`).join('');
  const linksMarkup=links.length?'<hyperlinks>'+hyperlinks.join('')+'</hyperlinks>':'';
  const sheet=xmlDeclaration+`<worksheet xmlns="${spreadsheetNs}" xmlns:r="${relNs}">
    <sheetPr><tabColor rgb="FF245453"/></sheetPr>
    <dimension ref="${dataRange}"/>
    <sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
    <sheetFormatPr defaultRowHeight="21"/><cols>${widths}</cols>
    <sheetData>${sheetRows.join('')}</sheetData><autoFilter ref="${dataRange}"/>${linksMarkup}
  </worksheet>`;
  const contentTypes=xmlDeclaration+`<Types xmlns="${contentTypeNs}">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
    <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
    <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
    <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  </Types>`;
  const rootRelationships=xmlDeclaration+`<Relationships xmlns="${packageNs}">
    <Relationship Id="rId1" Type="${relNs}/officeDocument" Target="xl/workbook.xml"/>
    <Relationship Id="rId2" Type="${packageNs}/metadata/core-properties" Target="docProps/core.xml"/>
  </Relationships>`;
  const workbook=xmlDeclaration+`<workbook xmlns="${spreadsheetNs}" xmlns:r="${relNs}"><bookViews><workbookView/></bookViews><sheets><sheet name="岗位列表" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const properties=xmlDeclaration+`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>小鲸岗位列表</dc:title><dc:creator>小鲸求职助手</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date(generatedAt).toISOString()}</dcterms:created></cp:coreProperties>`;
  return zip([
    ['[Content_Types].xml',contentTypes],['_rels/.rels',rootRelationships],['docProps/core.xml',properties],
    ['xl/workbook.xml',workbook],['xl/_rels/workbook.xml.rels',relationships([{id:'rId1',type:'worksheet',target:'worksheets/sheet1.xml'},{id:'rId2',type:'styles',target:'styles.xml'}])],
    ['xl/styles.xml',styles],['xl/worksheets/sheet1.xml',sheet],
    ...(links.length?[['xl/worksheets/_rels/sheet1.xml.rels',relationships(links)]]:[]),
  ]);
}

export function exportJobRows(rows,format,{generatedAt=Date.now()}={}){
  if(format==='csv')return {body:Buffer.from(csv(rows)),contentType:'text/csv; charset=utf-8',extension:'csv'};
  if(format==='json')return {body:Buffer.from(JSON.stringify({version:1,generatedAt:new Date(generatedAt).toISOString(),total:rows.length,jobs:rows},null,2)+'\n'),contentType:'application/json; charset=utf-8',extension:'json'};
  if(format==='xlsx')return {body:xlsx(rows,generatedAt),contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',extension:'xlsx'};
  throw Error('岗位导出格式无效');
}
