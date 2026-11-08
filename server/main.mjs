import {createApplication} from './app.mjs';
const app=createApplication();
app.server.listen(app.port,'127.0.0.1',()=>console.log(`小鲸求职 Agent：http://127.0.0.1:${app.port}/\n工程目录：${app.root}\n生成后端：${app.state.config.backend}；${app.state.config.running?'已恢复保存的运行通道':'启动时保持暂停'}。`));
app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'端口已被占用，请打开已有控制台。':e.message);process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,app.shutdown);
