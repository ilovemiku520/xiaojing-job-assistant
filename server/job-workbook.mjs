import {createHash} from 'node:crypto';
import {statSync} from 'node:fs';
import {mkdir, rename, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {exportJobRows} from './job-exports.mjs';

const fileName = '岗位实时.xlsx';

function usableFile(file) {
  try {
    const info = statSync(file,{throwIfNoEntry:false,bigint:true});
    if (info?.isFile() && info.size > 0n) return info;
  } catch {}
}

function unchangedFile(a,b) {
  return Boolean(a&&b&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs);
}

export function createJobWorkbook({
  directory,
  rows,
  project = async () => {
    const currentRows = await rows();
    return {rows:currentRows, signature:createHash('sha256').update(JSON.stringify(currentRows)).digest('hex')};
  },
  generate = currentRows => exportJobRows(currentRows, 'xlsx'),
  delayMs = 1500,
  retryMs = 5000,
  replace = rename
}) {
  const file = join(directory, fileName);
  const temporary = file + '.tmp';
  let revision = 0;
  let savedRevision = 0;
  let lastSignature = '';
  let savedFile = usableFile(file);
  let updatedAt = savedFile ? Number(savedFile.mtimeNs)/1000000 : 0;
  let timer;
  let staged;
  let writing;
  let closing;
  let closed = false;
  let state = updatedAt ? 'ready' : 'pending';

  function arm(delay) {
    if (closed || closing || timer || writing) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
    timer.unref();
  }

  function flush() {
    const currentRevision = revision;
    const done = writeRevision(currentRevision).then(delay => {
      writing = undefined;
      if (savedRevision !== revision) arm(delay);
    });
    writing = {revision:currentRevision,done};
    return done;
  }

  async function writeRevision(currentRevision) {
    const superseded = () => closed || (closing && currentRevision !== revision);
    state = 'writing';
    try {
      if (staged?.revision !== currentRevision) {
        const {rows:currentRows,signature} = await project();
        if (superseded()) return delayMs;
        const sameAsSaved = signature === lastSignature && unchangedFile(savedFile,usableFile(file));
        const body = sameAsSaved ? null : staged?.signature === signature ? staged.body : (await generate(currentRows)).body;
        if (superseded()) return delayMs;
        staged = {revision:currentRevision, signature, body};
      }
      const {body,signature} = staged;
      if (body) {
        await mkdir(directory, {recursive:true, mode:0o700});
        if (superseded()) return delayMs;
        await writeFile(temporary, body, {mode:0o600});
        if (superseded()) {
          await unlink(temporary).catch(() => {});
          return delayMs;
        }
        await replace(temporary, file);
        lastSignature = signature;
        savedFile = usableFile(file);
        updatedAt = Date.now();
      }
      staged = undefined;
      savedRevision = currentRevision;
      state = 'ready';
      return delayMs;
    } catch (error) {
      await unlink(temporary).catch(() => {});
      state = ['EBUSY','EACCES','EPERM'].includes(error.code) ? 'locked' : 'error';
      return retryMs;
    }
  }

  function close() {
    closed = true;
    clearTimeout(timer);
    timer = undefined;
    staged = undefined;
  }

  function flushAndClose(timeoutMs = 1800) {
    if (closing) return closing;
    if (closed || savedRevision === revision && !writing) {
      close();
      return Promise.resolve();
    }
    clearTimeout(timer);
    timer = undefined;
    const active = writing;
    let deadline;
    const limit = new Promise(done => {deadline = setTimeout(done, timeoutMs);});
    const finalWrite = Promise.resolve(active?.done).then(() => {
      if (!closed && savedRevision !== revision && active?.revision !== revision) return flush();
    });
    closing = Promise.race([limit, finalWrite]).finally(() => {
      clearTimeout(deadline);
      close();
    });
    return closing;
  }

  return {
    file,
    refresh() {
      if (closing || closed) return;
      revision++;
      if (state === 'ready') state = 'pending';
      arm(delayMs);
    },
    status() {
      const current=usableFile(file);
      return {state, fileName, updatedAt, ready:updatedAt>0&&Boolean(current), pending:savedRevision!==revision,
        externallyChanged:Boolean(savedFile&&current&&!unchangedFile(savedFile,current))};
    },
    close,
    flushAndClose
  };
}
