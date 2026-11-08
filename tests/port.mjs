import net from 'node:net';

// Some Windows environments assign small sequential ports for listen(0).
// Pick an explicit browser-safe range instead of repeatedly rejecting those ports.
export async function testPort(){
  for(let i=0;i<30;i++){
    // Stay below Windows' dynamic TCP range, which may be reserved between a
    // successful probe and the application bind during parallel browser checks.
    const port=20000+Math.floor(Math.random()*20000),probe=net.createServer();
    try{await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});await new Promise(r=>probe.close(r));return port;}
    catch(e){if(!['EADDRINUSE','EACCES'].includes(e.code))throw e;}
  }
  throw Error('未找到可用验证端口');
}
