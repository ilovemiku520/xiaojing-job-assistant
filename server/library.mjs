import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {basename, extname, join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const manifestName = 'owner-library.json';
const maxResumeBytes = 8 * 1024 * 1024;
const maxDocumentBytes = 256 * 1024;
const supportedDocuments = new Set(['.txt', '.md', '.markdown', '.json']);

function emptyLibrary() {
  return {persona: '', rules: '', documents: [], resume: null};
}

function readLibrary(directory) {
  const file = join(directory, manifestName);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : emptyLibrary();
}

function fileName(input) {
  const name = String(input || '').normalize('NFC').trim();
  if (!name || name.length > 180 || name !== basename(name) || /[\\/:*?"<>|\x00-\x1f]|\.$|^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name)) {
    throw Error('文件名称无效');
  }
  return name;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function searchTerms(value) {
  const normalized = String(value || '').toLowerCase().slice(0, 6000);
  const words = normalized.match(/[a-z0-9][a-z0-9_.+#-]{1,30}/g) || [];
  for (const text of normalized.match(/\p{Script=Han}{2,}/gu) || []) {
    for (let i = 0; i < text.length - 1; i++) words.push(text.slice(i, i + 2));
  }
  return [...new Set(words)].slice(0, 80);
}

export function ownerLibraryContext(directory, query) {
  const {persona, rules, documents} = readLibrary(directory);
  const terms = searchTerms(query);
  const snippets = [];
  for (const document of documents) {
    const title = document.name.toLowerCase();
    for (let start = 0; start < document.content.length; start += 1500) {
      const content = document.content.slice(start, start + 1800);
      const normalized = content.toLowerCase();
      const score = terms.reduce((total, term) => total + (title.includes(term) ? 3 : 0) + (normalized.includes(term) ? 1 : 0), 0);
      if (score) snippets.push({source:document.name, content, score});
    }
  }
  snippets.sort((a, b) => b.score - a.score);
  return {persona, rules, snippets: snippets.slice(0, 3).map(({source, content}) => ({source, content}))};
}

export function createOwnerLibrary(directory) {
  function save(state) {
    mkdirSync(directory, {recursive:true, mode:0o700});
    const file = join(directory, manifestName);
    writeFileSync(file + '.tmp', JSON.stringify(state), {mode:0o600});
    renameSync(file + '.tmp', file);
  }

  function state() {
    const {documents, ...rest} = readLibrary(directory);
    return {...rest, documents: documents.map(({content, hash, ...metadata}) => metadata)};
  }

  function setPersona(input) {
    const fields = Object.entries({persona:10000,rules:16000}).filter(([key]) => Object.hasOwn(input || {},key));
    if (!fields.length || fields.some(([key,limit]) => typeof input[key] !== 'string' || input[key].length > limit)) {
      throw Error('人格设定最多 10,000 字，附加规则最多 16,000 字');
    }
    const current = readLibrary(directory);
    for (const [key] of fields) current[key] = input[key].trim();
    save(current);
    return state();
  }

  function importDocument(input) {
    const name = fileName(input.name);
    if (!supportedDocuments.has(extname(name).toLowerCase())) throw Error('知识资料支持 TXT、Markdown 和 JSON');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0') || Buffer.byteLength(input.text) > maxDocumentBytes) {
      throw Error('知识资料须为有效 UTF-8 文本，每份最多 256 KB');
    }
    const content = input.text.replace(/^\uFEFF/, '').trim();
    if (extname(name).toLowerCase() === '.json') {
      try {JSON.parse(content);} catch {throw Error('JSON 文件格式无效');}
    }
    const current = readLibrary(directory);
    const hash = digest(content);
    if (current.documents.some(document => document.hash === hash)) return {...state(), importStatus:'duplicate'};
    if (current.documents.length >= 40) throw Error('知识库最多保留 40 份资料');
    current.documents.push({id:randomUUID(), name, content, hash, bytes:Buffer.byteLength(content), addedAt:Date.now()});
    save(current);
    return {...state(), importStatus:'added'};
  }

  function removeDocument(id) {
    const current = readLibrary(directory);
    current.documents = current.documents.filter(document => document.id !== id);
    save(current);
    return state();
  }

  function importResume(input) {
    const name = fileName(input.name);
    if (!/\.pdf$/i.test(name) || typeof input.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) {
      throw Error('请选择 PDF 简历');
    }
    const bytes = Buffer.from(input.base64, 'base64');
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) || bytes.length > maxResumeBytes) {
      throw Error('PDF 简历格式无效或超过 8 MB');
    }
    const current = readLibrary(directory);
    const id = digest(bytes);
    const folder = join(directory, 'resumes', id);
    mkdirSync(folder, {recursive:true, mode:0o700});
    const path = join(folder, name);
    if (!existsSync(path)) {
      writeFileSync(path + '.tmp', bytes, {mode:0o600});
      renameSync(path + '.tmp', path);
    }
    current.resume = {id, name, bytes:bytes.length, addedAt:Date.now()};
    save(current);
    return state();
  }

  function activeResume() {
    const resume = readLibrary(directory).resume;
    if (!resume || !/^[0-9a-f]{64}$/.test(resume.id)) return null;
    const path = join(directory, 'resumes', resume.id, fileName(resume.name));
    return existsSync(path) ? {...resume, path} : null;
  }

  return {state, setPersona, importDocument, removeDocument, importResume, activeResume};
}
