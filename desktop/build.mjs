import {createHash} from 'node:crypto';
import {createReadStream, existsSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = 'electron-v45.2.3-win32-x64.zip';
const checksum = '489cd061908e697394b004298bf5ffd345c935d10e8ca197ba819f019ab2dec0';
const source = resolve(process.argv[2] || join(root, 'tools/cache/electron', runtime));
if (!existsSync(source)) throw Error('Missing official Electron Windows x64 archive: ' + source);
const sha = createHash('sha256');
for await (const chunk of createReadStream(source)) sha.update(chunk);
if (sha.digest('hex') !== checksum) throw Error('Electron archive SHA-256 mismatch');

const output = join(root, 'output', 'desktop');
const packageInfo = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = 'Xiaojing-Desktop-' + packageInfo.version + '-Windows-x64';
const destination = join(output, name);
const zip = join(output, name + '.zip');
const windows = process.env.SystemRoot;
const compiler = windows && join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!compiler || !existsSync(compiler)) throw Error('Building the Windows package requires the Windows .NET Framework C# compiler.');
mkdirSync(output, {recursive:true});
if (existsSync(destination) || existsSync(zip)) throw Error('Move the previous desktop build before building a new release.');
const temporary = realpathSync(mkdtempSync(join(output, 'stage-')));
if (dirname(temporary) !== realpathSync(output)) throw Error('Unexpected staging directory');
const staged = join(temporary, name);
const resource = join(staged, 'resources', 'app');

function run(command, args, failure) {
  const result = spawnSync(command, args, {stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(failure);
}

try {
  const resourceEditor = join(temporary, 'embed-icon.exe');
  run(compiler, ['/nologo', '/out:' + resourceEditor, join(root, 'desktop', 'embed-icon.cs')], 'Could not compile the Windows resource editor');
  mkdirSync(staged);
  run('tar', ['-xf', source, '-C', staged], 'Could not extract the Electron archive');
  const executable = join(staged, 'Xiaojing.exe');
  renameSync(join(staged, 'electron.exe'), executable);
  run(resourceEditor, [executable, join(root, 'desktop', 'assets', 'xiaojing-icon.ico'), packageInfo.version], 'Could not embed the Windows application resources');
  mkdirSync(resource, {recursive:true});
  writeFileSync(join(resource, 'package.json'), JSON.stringify({name:'xiaojing-desktop',version:packageInfo.version,private:true,type:'module',main:'desktop/main.mjs'}, null, 2));
  for (const directory of ['server','public','extension']) {
    const files = readdirSync(join(root,directory),{withFileTypes:true}).filter(entry=>entry.isFile() && /\.(mjs|js|css|html|json)$/.test(entry.name));
    mkdirSync(join(resource,directory));
    for (const file of files) cpSync(join(root,directory,file.name), join(resource,directory,file.name));
  }
  const files = [
    'desktop/main.mjs','desktop/preload.cjs','desktop/browser-setup.mjs','desktop/extension-pairing.js','desktop/starter',
    'desktop/assets/xiaojing-icon.png',
    'desktop/embedded-browser.mjs','desktop/embedded-worker.mjs','desktop/boss-preload.cjs','desktop/boss-content-shim.js',
    'tools/boss-task.mjs','tools/boss-mcp.mjs','tools/boss-web-mcp.mjs'
  ];
  for (const path of files) {
    mkdirSync(dirname(join(resource,path)),{recursive:true});
    cpSync(join(root,path),join(resource,path),{recursive:true});
  }
  cpSync(join(root,'desktop','README.md'),join(staged,'README.md'));
  for (const file of ['LICENSE','NOTICE']) {
    const projectNotice = join(root, file);
    if (existsSync(projectNotice)) cpSync(projectNotice, join(staged, file + '-XIAOJING.txt'));
  }
  run('tar', ['--format','zip','--options','zip:hdrcharset=UTF-8','-cf',join(temporary,name+'.zip'),'-C',temporary,name], 'Could not create the portable ZIP');
  renameSync(staged,destination);
  renameSync(join(temporary,name+'.zip'),zip);
  console.log(join(destination,'Xiaojing.exe'));
  console.log(zip);
} finally {
  rmSync(temporary,{recursive:true,force:true});
}
