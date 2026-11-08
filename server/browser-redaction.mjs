import {Transform} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';

export function scrubBrowserText(text,token=''){
 let value=String(text);if(token)value=value.split(token).join('[redacted]');
 return value.replace(/([?&]token=)[^&\s"'<>)]*/gi,'$1[redacted]');
}
export function browserOutputFilter(token=''){
 const decoder=new StringDecoder('utf8');let pending='';
 return new Transform({
  transform(chunk,encoding,callback){
   pending+=decoder.write(chunk);let end;
   while((end=pending.indexOf('\n'))!==-1){this.push(scrubBrowserText(pending.slice(0,end+1),token));pending=pending.slice(end+1);}
   callback();
  },
  flush(callback){pending+=decoder.end();if(pending)this.push(scrubBrowserText(pending,token));callback();}
 });
}
