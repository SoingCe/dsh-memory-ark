#!/usr/bin/env node
/**
 * memvault.mjs — 记忆方舟
 *
 * 把 DSH 工作区的会话全部导出成一个可搬运的「记忆库」，
 * 再从库里挑出需要的记忆，写回目标工作区（MEMORY.md + 鱼的记忆）。
 *
 * 零依赖，使用 DSH 自带的 Node（>= 22.15，需要 node:zlib 的 zstd）。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DEFAULT_VAULT = path.join(SCRIPT_DIR, 'vault')
const SCHEMA = 1

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0]

async function main() {
  switch (cmd) {
    case 'workspaces':
      return cmdWorkspaces()
    case 'sessions':
      return cmdSessions()
    case 'backup':
      return cmdBackup()
    case 'chunks':
      return cmdChunks()
    case 'save-cards':
      return cmdSaveCards()
    case 'search':
      return cmdSearch()
    case 'review':
      return cmdReview()
    case 'keep':
      return cmdKeep()
    case 'status':
      return cmdStatus()
    case 'doctor':
      return cmdDoctor()
    case 'mirror':
      return cmdMirror()
    case 'help':
    case undefined:
      return usage()
    default:
      throw new Error('不认识的命令：' + cmd + '（memvault help 看用法）')
  }
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      let k = a.slice(2)
      let v = true
      const eq = k.indexOf('=')
      if (eq !== -1) {
        v = k.slice(eq + 1)
        k = k.slice(0, eq)
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        v = argv[i + 1]
        i++
      }
      out[k] = v
    } else out._.push(a)
  }
  return out
}

function flag(name) {
  return args[name] !== undefined && args[name] !== false
}

function vaultDir() {
  return path.resolve(args.vault || DEFAULT_VAULT)
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

function statSize(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex')
}

function shortHash(s) {
  return sha1(s).slice(0, 6)
}

function nowIso() {
  return new Date().toISOString()
}

const TZ = 'Asia/Shanghai'
const dtf = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})
const df = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })

function fmtTime(t) {
  if (!t) return ''
  return dtf.format(new Date(t)).replace('T', ' ')
}

function fmtDate(t) {
  if (!t) return ''
  return df.format(new Date(t))
}

function today() {
  return df.format(new Date())
}

function slugify(p) {
  const base = path.basename(p).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
  return base + '-' + shortHash(path.resolve(p).toLowerCase())
}

function humanSize(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function truncate(s, n) {
  s = String(s || '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

/* ------------------------------------------------------------------ */
/* DSH 数据                                                            */
/* ------------------------------------------------------------------ */

function loadRegistry() {
  const p = path.join(DSH_HOME, 'storages', 'workspace.json')
  const j = readJson(p, {})
  const t = (j.tables && j.tables.workspaces) || {}
  return Object.entries(t).map(([id, w]) => ({
    id,
    path: w.path,
    title: w.title || path.basename(w.path || ''),
    sessionIds: w.sessionIds || [],
    updatedAt: w.updatedAt,
  }))
}

function normPath(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
}

function findWorkspace(p) {
  const all = loadRegistry()
  const target = normPath(p)
  return all.find((w) => w.path && normPath(w.path) === target) || null
}

function currentWorkspace() {
  const cwd = args.workspace ? path.resolve(args.workspace) : process.cwd()
  const w = findWorkspace(cwd)
  return w || { id: null, path: cwd, title: path.basename(cwd), sessionIds: [] }
}

function sessionFileMap() {
  const root = path.join(DSH_HOME, 'sessions')
  const map = new Map()
  if (!exists(root)) return map
  for (const bucket of fs.readdirSync(root)) {
    const b = path.join(root, bucket)
    let sids = []
    try {
      sids = fs.readdirSync(b)
    } catch {
      continue
    }
    for (const sid of sids) {
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const f = path.join(b, sid, name)
        if (exists(f)) {
          map.set(sid, f)
          break
        }
      }
    }
  }
  return map
}

/**
 * DSH 的会话文件是「多帧 zstd 追加」格式。
 * node:zlib 的 zstdDecompressSync 一次只解一帧，所以按魔数切帧逐个解。
 */
function decodeSessionFile(file) {
  const buf = fs.readFileSync(file)
  if (!file.endsWith('.zstd')) return buf.toString('utf8')
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('当前 Node 不支持 zstd，请用 DSH 自带的 Node（v22.15+）运行')
  }
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let i = 0
  while ((i = buf.indexOf(magic, i)) !== -1) {
    starts.push(i)
    i += 4
  }
  if (!starts.length) throw new Error('不是 zstd 文件：' + file)
  const parts = []
  for (const s of starts) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(s)))
    } catch {
      // 尾部可能正在写；这一帧放弃，前面的已经拿到了
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

function parseSession(file) {
  const text = decodeSessionFile(file)
  const raw = []
  let header = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.type === 'session') header = rec
    raw.push(rec)
  }
  return { header, raw }
}

function contentParts(content) {
  if (!Array.isArray(content)) return []
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text)
}

function recordSummary(rec, opts = {}) {
  const maxTool = opts.maxTool || 400
  const out = []
  switch (rec.type) {
    case 'user/message': {
      const src = (rec.data && rec.data.source && rec.data.source.kind) || 'user'
      // DSH 会把运行时上下文、技能目录、时间戳注入成 user/message，
      // 这些不是用户说的话，不进记忆库。
      if (src !== 'user') break
      const txt = contentParts(rec.data && rec.data.content).join('\n').trim()
      if (txt && !txt.startsWith('Current runtime context.')) out.push({ role: 'user', time: rec.time, text: txt })
      break
    }
    case 'assistant/message': {
      const c = rec.data && rec.data.message && rec.data.message.content
      const txt = contentParts(c).join('\n').trim()
      if (txt) out.push({ role: 'assistant', time: rec.time, text: txt })
      break
    }
    case 'tool/call': {
      const d = rec.data || {}
      out.push({
        role: 'tool-call',
        time: rec.time,
        text: '`' + d.name + '` ' + truncate(d.arguments || '', maxTool),
      })
      break
    }
    case 'tool/result': {
      const c = rec.data && rec.data.message && rec.data.message.content
      const txt = contentParts(c).join('\n').trim()
      if (txt) out.push({ role: 'tool-result', time: rec.time, text: truncate(txt, maxTool) })
      break
    }
  }
  return out
}

function renderTranscript(meta, raw) {
  const lines = []
  lines.push('# ' + (meta.title || meta.sessionId))
  lines.push('')
  lines.push('- 工作区：`' + meta.workspacePath + '`')
  lines.push('- 会话：`' + meta.sessionId + '`')
  lines.push('- 起始：' + fmtTime(meta.createdAt))
  lines.push('- 最后：' + fmtTime(meta.lastAt))
  lines.push('- 用户消息：' + meta.userMessages + ' · 助手消息：' + meta.assistantMessages + ' · 工具调用：' + meta.toolCalls)
  lines.push('')
  lines.push('> 工具调用与结果已截断保留；完整原文见同目录 `raw.jsonl`。内部推理不导出。')
  lines.push('')
  for (const rec of raw) {
    for (const s of recordSummary(rec)) {
      if (s.role === 'user') {
        lines.push('### ' + fmtTime(s.time) + ' · 用户')
        lines.push('')
        lines.push(s.text)
        lines.push('')
      } else if (s.role === 'assistant') {
        lines.push('### ' + fmtTime(s.time) + ' · 助手')
        lines.push('')
        lines.push(s.text)
        lines.push('')
      } else if (s.role === 'tool-call') {
        lines.push('> 🔧 ' + s.text)
        lines.push('')
      } else if (s.role === 'tool-result') {
        lines.push('> 📄 ' + s.text.replace(/\n/g, '\n> '))
        lines.push('')
      }
    }
  }
  return lines.join('\n')
}

function sessionTitle(raw) {
  let title = ''
  for (const rec of raw) {
    if (rec.type === 'session/title' && rec.data && rec.data.title) title = rec.data.title
  }
  return title
}

function stats(raw) {
  let user = 0
  let assistant = 0
  let tools = 0
  let lastAt = 0
  let chars = 0
  for (const rec of raw) {
    if (rec.time) lastAt = Math.max(lastAt, rec.time)
    for (const s of recordSummary(rec, { maxTool: 0 })) {
      if (s.role === 'user') {
        user++
        chars += s.text.length
      } else if (s.role === 'assistant') {
        assistant++
        chars += s.text.length
      } else if (s.role === 'tool-call') tools++
    }
  }
  return { user, assistant, tools, lastAt, chars }
}

/* ------------------------------------------------------------------ */
/* 记忆库索引                                                           */
/* ------------------------------------------------------------------ */

function indexPath(vault) {
  return path.join(vault, 'index.json')
}

function loadIndex(vault) {
  return readJson(indexPath(vault), { schema: SCHEMA, createdAt: nowIso(), updatedAt: nowIso(), sources: {} })
}

function saveIndex(vault, idx) {
  idx.updatedAt = nowIso()
  writeJson(indexPath(vault), idx)
}

function sourceDir(vault, slug) {
  return path.join(vault, 'sources', slug)
}

function cardsPath(vault) {
  return path.join(vault, 'cards.json')
}

function loadCards(vault) {
  return readJson(cardsPath(vault), { schema: SCHEMA, updatedAt: null, cards: [] })
}

function saveCards(vault, data) {
  data.updatedAt = nowIso()
  writeJson(cardsPath(vault), data)
}

/* ------------------------------------------------------------------ */
/* 命令：workspaces                                                    */
/* ------------------------------------------------------------------ */

function cmdWorkspaces() {
  const list = loadRegistry()
  const files = sessionFileMap()
  if (!list.length) {
    console.log('没有找到已注册的工作区。')
    return
  }
  console.log('已注册的 DSH 工作区：\n')
  for (const w of list) {
    let last = 0
    let have = 0
    for (const sid of w.sessionIds) {
      const f = files.get(sid)
      if (!f) continue
      have++
      last = Math.max(last, fs.statSync(f).mtimeMs)
    }
    console.log('- ' + w.title)
    console.log('  路径：' + w.path)
    console.log('  会话：' + have + '/' + w.sessionIds.length + ' · 最近活动：' + (last ? fmtTime(last) : '—'))
    console.log('  工作区 ID：' + w.id)
    console.log('  记忆库代号：' + slugify(w.path))
    console.log('  列会话：memvault.cmd sessions --workspace-id ' + w.id)
    console.log('')
  }
}

/* ------------------------------------------------------------------ */
/* 命令：sessions                                                      */
/* ------------------------------------------------------------------ */

/** 一个工作区里的会话，按最近活动排序；meta 有就用 meta，没有就解一次。 */
function listWorkspaceSessions(ws, vault = vaultDir()) {
  const files = sessionFileMap()
  const slug = slugify(ws.path)
  const out = []
  for (const sid of ws.sessionIds) {
    const file = files.get(sid)
    if (!file) continue
    let st
    try {
      st = fs.statSync(file)
    } catch {
      continue
    }
    const meta = readJson(path.join(vault, 'sources', slug, 'sessions', sid, 'meta.json'), null)
    let title = meta && meta.title
    let messages = meta ? (meta.userMessages || 0) + (meta.assistantMessages || 0) : 0
    let lastAt = (meta && meta.lastAt) || st.mtimeMs
    if (!title) {
      try {
        const { raw } = parseSession(file)
        title = sessionTitle(raw) || sid
        const s = stats(raw)
        messages = s.user + s.assistant
        lastAt = s.lastAt || lastAt
      } catch {
        title = sid
      }
    }
    out.push({
      id: sid,
      file,
      bytes: st.size,
      mtime: st.mtimeMs,
      lastAt,
      title,
      messages,
    })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

function cmdSessions() {
  const vault = vaultDir()
  const list = loadRegistry()
  let ws = null
  if (args['workspace-id']) {
    ws = list.find((w) => String(w.id).toLowerCase() === String(args['workspace-id']).toLowerCase())
  } else if (args.workspace) {
    ws = findWorkspace(path.resolve(String(args.workspace)))
  } else if (args.source) {
    const idx = loadIndex(vault)
    const key = String(args.source)
    const s =
      idx.sources[key] ||
      Object.values(idx.sources).find((x) => x.workspaceId && String(x.workspaceId).toLowerCase() === key.toLowerCase())
    if (s) ws = findWorkspace(s.path)
  } else if (args._[1]) {
    ws = findWorkspace(resolveWorkspaceByText(list, String(args._[1])))
  } else {
    ws = findWorkspace(process.cwd())
  }
  if (!ws) {
    throw new Error('要列哪个工作区的会话？加 --workspace-id <工作区ID> 或 "工作区名"。先 memvault.cmd workspaces 看。')
  }

  const sessions = listWorkspaceSessions(ws, vault)
  if (flag('json')) {
    console.log(
      JSON.stringify(
        {
          workspace: { id: ws.id, title: ws.title, path: ws.path },
          sessions: sessions.map((s, i) => ({
            index: i + 1,
            id: s.id,
            title: s.title,
            lastAt: s.lastAt,
            messages: s.messages,
            bytes: s.bytes,
          })),
        },
        null,
        2,
      ),
    )
    return
  }

  console.log('工作区：' + ws.title)
  console.log('工作区 ID：' + ws.id)
  console.log('会话：' + sessions.length + ' 个（按最近活动排）\n')
  sessions.forEach((s, i) => {
    console.log('  ' + (i + 1) + '. ' + fmtTime(s.lastAt) + '   ' + s.title)
    console.log('     ' + (s.messages || 0) + ' 条 · ' + humanSize(s.bytes) + ' · ' + s.id)
  })
  console.log('')
  console.log('备份其中一个：memvault.cmd backup --workspace-id ' + ws.id + ' --session <序号或会话id>')
  console.log('备份全部：    memvault.cmd backup --workspace-id ' + ws.id + ' --all')
}

/* ------------------------------------------------------------------ */
/* 命令：backup                                                        */
/* ------------------------------------------------------------------ */

function resolveWorkspaceByText(list, text) {
  const q = String(text).toLowerCase()
  const exact = list.filter(
    (w) => slugify(w.path) === q || String(w.title).toLowerCase() === q || String(w.id).toLowerCase() === q,
  )
  if (exact.length === 1) return exact[0].path
  const part = list.filter(
    (w) => String(w.title).toLowerCase().includes(q) || String(w.path).toLowerCase().includes(q),
  )
  if (part.length === 1) return part[0].path
  if (!part.length) throw new Error('没有匹配的工作区：' + text + '（先跑 memvault.cmd workspaces）')
  throw new Error('匹配到多个，写清楚一点：\n' + part.map((w) => '  - ' + w.title + '  ' + w.path).join('\n'))
}

async function pickWorkspace(list) {
  if (!list.length) throw new Error('没有已注册的工作区。')
  console.log('要备份哪一个工作区？（只备份你选的那个）\n')
  list.forEach((w, i) => {
    console.log('  ' + (i + 1) + '. ' + w.title + '   ' + w.sessionIds.length + ' 个会话')
    console.log('     ' + w.path)
  })
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const ans = (await rl.question('\n输入序号（直接回车取消）：')).trim()
    if (!ans) return null
    const n = Number(ans)
    if (!Number.isInteger(n) || n < 1 || n > list.length) throw new Error('序号不对：' + ans)
    return list[n - 1]
  } finally {
    rl.close()
  }
}

function resolveSessionArg(sessions, val) {
  const q = String(val).trim()
  if (/^\d+$/.test(q)) {
    const i = Number(q) - 1
    if (!sessions[i]) throw new Error('序号超出范围：' + q + '（这个工作区共 ' + sessions.length + ' 个会话）')
    return sessions[i].id
  }
  const exact = sessions.find((s) => s.id === q)
  if (exact) return exact.id
  const pref = sessions.filter((s) => s.id.startsWith(q))
  if (pref.length === 1) return pref[0].id
  if (!pref.length) throw new Error('这个工作区里没有这个会话：' + q)
  throw new Error('匹配到多个会话，写长一点：\n' + pref.map((s) => '  ' + s.id).join('\n'))
}

async function pickSession(sessions) {
  if (!sessions.length) throw new Error('这个工作区没有可读的会话。')
  console.log('这个工作区有 ' + sessions.length + ' 个会话，要备份哪一个？\n')
  sessions.forEach((s, i) => {
    console.log('  ' + (i + 1) + '. ' + fmtTime(s.lastAt) + '   ' + s.title)
    console.log('     ' + (s.messages || 0) + ' 条 · ' + humanSize(s.bytes) + ' · ' + s.id)
  })
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const ans = (await rl.question('\n输入序号（直接回车取消；全部备份用 --all）：')).trim()
    if (!ans) return null
    const n = Number(ans)
    if (!Number.isInteger(n) || n < 1 || n > sessions.length) throw new Error('序号不对：' + ans)
    return sessions[n - 1]
  } finally {
    rl.close()
  }
}

async function cmdBackup() {
  const vault = vaultDir()
  const idx = loadIndex(vault)

  const given = []
  if (args.source) given.push('--source')
  if (args.workspace) given.push('--workspace')
  if (args['workspace-id']) given.push('--workspace-id')
  if (args['from-session']) given.push('--from-session')
  if (flag('here')) given.push('--here')
  if (given.length > 1) {
    throw new Error('一次只能指定一个目标，收到：' + given.join(' / '))
  }

  let targetPath
  if (args.source) {
    const key = String(args.source)
    const s =
      idx.sources[key] ||
      Object.values(idx.sources).find((x) => x.workspaceId && String(x.workspaceId).toLowerCase() === key.toLowerCase())
    if (s) {
      targetPath = s.path
    } else {
      const w = loadRegistry().find((x) => String(x.id).toLowerCase() === key.toLowerCase())
      if (!w) throw new Error('记忆库里没有这个来源：' + key + '（先跑 memvault status 看看）')
      targetPath = w.path
    }
  } else if (args.workspace) {
    targetPath = path.resolve(String(args.workspace))
  } else if (args['workspace-id']) {
    const w = loadRegistry().find((x) => String(x.id).toLowerCase() === String(args['workspace-id']).toLowerCase())
    if (!w) throw new Error('没有这个工作区 ID：' + args['workspace-id'] + '\n先跑 memvault.cmd workspaces 看。')
    targetPath = w.path
  } else if (args['from-session']) {
    const sid = String(args['from-session'])
    const w = loadRegistry().find((x) => x.sessionIds.includes(sid))
    if (!w) {
      throw new Error(
        '这个 session id 不属于任何已注册工作区（可能是子代理会话）：' + sid + '\n用 memvault.cmd workspaces 看工作区 ID。',
      )
    }
    targetPath = w.path
  } else if (flag('here')) {
    targetPath = process.cwd()
  } else if (args._[1]) {
    // 直接点名：memvault backup default-workspace / 94626f81-...
    targetPath = resolveWorkspaceByText(loadRegistry(), String(args._[1]))
  } else if (process.stdin.isTTY) {
    // 没有参数、在终端里：列出来让用户选一个
    const picked = await pickWorkspace(loadRegistry())
    if (!picked) {
      console.log('已取消，没有备份。')
      return
    }
    targetPath = picked.path
  } else {
    const list = loadRegistry()
    throw new Error(
      '没有指定工作区。一次只备份一个，把要备份的那个点名：\n' +
        list
          .map((w) => '  ' + w.title + '  →  memvault.cmd backup --workspace-id ' + w.id)
          .join('\n') +
        '\n也可以 memvault.cmd backup "工作区名" 或 --workspace "路径"。',
    )
  }

  const ws = findWorkspace(targetPath)
  if (!ws) {
    throw new Error('不是已注册的 DSH 工作区：' + targetPath + '\n先跑 memvault.cmd workspaces 看可选的路径和代号。')
  }
  if (path.resolve(ws.path) === path.resolve(SCRIPT_DIR)) {
    throw new Error('这是记忆库自己的工作区，不能备份它自己。请用 --source/--workspace 指定源工作区。')
  }

  const files = sessionFileMap()
  const slug = slugify(ws.path)
  const sdir = sourceDir(vault, slug)
  const force = flag('force')

  if (args['from-session'] && (args.session || flag('all'))) {
    throw new Error('--from-session 已经指定了会话，不能再加 --session / --all。')
  }
  if (args.session && flag('all')) {
    throw new Error('--session 和 --all 只能选一个：要么备份一个会话，要么整个工作区。')
  }

  const sessions = listWorkspaceSessions(ws, vault)
  if (!sessions.length) throw new Error('这个工作区没有可读的会话。')

  let targets
  if (args['from-session']) {
    const sid = String(args['from-session'])
    if (!sessions.some((s) => s.id === sid)) {
      throw new Error('这个会话不属于「' + ws.title + '」：' + sid)
    }
    targets = [sid]
  } else if (flag('all')) {
    targets = sessions.map((s) => s.id)
  } else if (args.session) {
    targets = [resolveSessionArg(sessions, args.session)]
  } else if (process.stdin.isTTY) {
    const picked = await pickSession(sessions)
    if (!picked) {
      console.log('已取消，没有备份。')
      return
    }
    targets = [picked.id]
  } else {
    throw new Error(
      '要备份哪个会话？一次备份一个（整个工作区用 --all）：\n' +
        sessions.map((s, i) => '  [' + (i + 1) + '] ' + s.title + '  ' + s.id).join('\n') +
        '\n用法：memvault.cmd backup --workspace-id ' + ws.id + ' --session <序号或会话id>',
    )
  }

  // 只允许备份目标工作区自己的会话，拒绝拿别的会话 id 混进来
  const own = new Set(ws.sessionIds)
  const foreign = targets.filter((sid) => !own.has(sid))
  if (foreign.length) {
    throw new Error('这些会话不属于「' + ws.title + '」，拒绝跨工作区备份：\n  ' + foreign.join('\n  '))
  }

  const selected = sessions.filter((s) => targets.includes(s.id))
  console.log('🐋 记忆方舟 · 备份' + (flag('dry-run') ? '（预览）' : ''))
  console.log(
    '  本次只备份：' +
      ws.title +
      (selected.length === 1 ? ' / ' + selected[0].title : ' / 全部 ' + selected.length + ' 个会话（--all）'),
  )
  console.log('  工作区 ID：' + ws.id)
  console.log('  路径：' + ws.path)
  console.log('  会话：' + targets.length + ' 个')
  console.log('  记忆库：' + vault)
  console.log('')

  if (flag('dry-run')) {
    for (const sid of targets) {
      const src = files.get(sid)
      if (!src) {
        console.log('  - ' + sid + '  （会话文件缺失）')
        continue
      }
      const old = readJson(path.join(sdir, 'sessions', sid, 'meta.json'), null)
      let title = old && old.title
      if (!title) {
        try {
          title = sessionTitle(parseSession(src).raw)
        } catch {
          title = ''
        }
      }
      console.log('  - ' + (title || sid) + '  ' + humanSize(fs.statSync(src).size))
    }
    console.log('\n预览完，没有写任何文件。去掉 --dry-run 才会真正备份。')
    return
  }

  let done = 0
  let skipped = 0
  let failed = 0

  for (const sid of targets) {
    const src = files.get(sid)
    if (!src) {
      console.log('  ! ' + sid + '：找不到会话文件，跳过')
      failed++
      continue
    }
    try {
      const srcStat = fs.statSync(src)
      const sha = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex')
      const metaFile = path.join(sdir, 'sessions', sid, 'meta.json')
      const old = readJson(metaFile, null)
      if (!force && old && old.sourceSha256 === sha) {
        console.log('  = ' + sid + '：没有变化，跳过')
        skipped++
        continue
      }

      const { header, raw } = parseSession(src)
      const title = sessionTitle(raw) || sid
      const st = stats(raw)
      const meta = {
        sessionId: sid,
        title,
        workspace: ws.title,
        workspaceId: ws.id,
        workspacePath: ws.path,
        createdAt: (header && header.createdAt) || 0,
        lastAt: st.lastAt || srcStat.mtimeMs,
        userMessages: st.user,
        assistantMessages: st.assistant,
        toolCalls: st.tools,
        chars: st.chars,
        records: raw.length,
        sourceFile: src,
        sourceBytes: srcStat.size,
        sourceSha256: sha,
        exportedAt: nowIso(),
      }

      writeText(path.join(sdir, 'sessions', sid, 'transcript.md'), renderTranscript(meta, raw))
      // raw.jsonl：保证「全部内容」都在，包括工具结果与推理原文
      const rawText = raw.map((r) => JSON.stringify(r)).join('\n') + '\n'
      writeText(path.join(sdir, 'sessions', sid, 'raw.jsonl'), rawText)
      writeJson(metaFile, meta)

      const memSrc = path.join(DSH_HOME, 'fish-memory', sid + '.json')
      if (exists(memSrc)) {
        fs.copyFileSync(memSrc, path.join(sdir, 'sessions', sid, 'memory.json'))
      }

      if (!flag('no-files')) copyWorkspaceFiles(ws.path, sdir)

      idx.sources[slug] = idx.sources[slug] || { title: ws.title, path: ws.path, sessions: {} }
      idx.sources[slug].path = ws.path
      idx.sources[slug].title = ws.title
      idx.sources[slug].workspaceId = ws.id
      idx.sources[slug].lastBackupAt = nowIso()
      idx.sources[slug].sessions[sid] = {
        title,
        lastAt: meta.lastAt,
        userMessages: meta.userMessages,
        assistantMessages: meta.assistantMessages,
        chars: meta.chars,
        exportedAt: meta.exportedAt,
        sourceSha256: sha,
      }

      console.log('  ✓ ' + title)
      console.log(
        '    ' + meta.userMessages + ' 条用户 / ' + meta.assistantMessages + ' 条助手 / ' + meta.toolCalls + ' 次工具 · ' + humanSize(srcStat.size),
      )
      done++
    } catch (e) {
      console.log('  ✖ ' + sid + '：' + e.message)
      failed++
    }
  }

  saveIndex(vault, idx)
  console.log('')
  console.log('完成：' + done + ' 个会话已备份，' + skipped + ' 个没变化，' + failed + ' 个失败。')
  console.log('下次：memvault chunks --source ' + slug + ' 生成提炼用的分段。')
}

function copyWorkspaceFiles(wsPath, sdir) {
  const out = path.join(sdir, 'workspace-files')
  const skip = new Set(['node_modules', '.git', '.dsh', 'memory-vault', 'vault', 'venv', '.venv'])
  let count = 0
  let bytes = 0
  const walk = (rel, depth) => {
    if (count >= 40 || bytes > 3 * 1024 * 1024 || depth > 3) return
    let names = []
    try {
      names = fs.readdirSync(path.join(wsPath, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of names) {
      if (count >= 40 || bytes > 3 * 1024 * 1024) return
      if (skip.has(ent.name)) continue
      const r = rel ? path.join(rel, ent.name) : ent.name
      const abs = path.join(wsPath, r)
      if (ent.isDirectory()) {
        if (/^(docs?|notes?|memory|archive)$/i.test(ent.name)) walk(r, depth + 1)
        continue
      }
      if (!/\.(md|markdown|txt)$/i.test(ent.name)) continue
      try {
        const st = fs.statSync(abs)
        if (st.size > 512 * 1024) continue
        fs.mkdirSync(path.join(out, path.dirname(r)), { recursive: true })
        fs.copyFileSync(abs, path.join(out, r))
        count++
        bytes += st.size
      } catch {
        // ignore
      }
    }
  }
  walk('', 0)
}

/* ------------------------------------------------------------------ */
/* 命令：chunks                                                        */
/* ------------------------------------------------------------------ */

function cmdChunks() {
  const vault = vaultDir()
  const idx = loadIndex(vault)
  const sourceSlug = args.source ? String(args.source) : null
  const sid = args.session ? String(args.session) : null
  const size = Math.max(4000, Number(args.chars) || 24000)

  let picked = []
  for (const [slug, src] of Object.entries(idx.sources)) {
    if (sourceSlug && slug !== sourceSlug) continue
    for (const [id, meta] of Object.entries(src.sessions)) {
      if (sid && id !== sid) continue
      picked.push({ slug, id, meta })
    }
  }
  if (!picked.length) throw new Error('没有找到对应会话，先跑 memvault backup。')

  for (const p of picked) {
    const dir = path.join(vault, 'sources', p.slug, 'sessions', p.id)
    const rawFile = path.join(dir, 'raw.jsonl')
    if (!exists(rawFile)) {
      console.log('! ' + p.id + '：缺 raw.jsonl，跳过')
      continue
    }
    const raw = fs
      .readFileSync(rawFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)

    const turns = []
    for (const rec of raw) {
      for (const s of recordSummary(rec, { maxTool: 0 })) {
        if (s.role === 'user' || s.role === 'assistant') {
          turns.push({ role: s.role, time: s.time, text: s.text })
        }
      }
    }

    const chunks = []
    let cur = []
    let curLen = 0
    for (const t of turns) {
      const piece = (t.role === 'user' ? '用户' : '助手') + '：' + t.text + '\n\n'
      if (curLen + piece.length > size && cur.length) {
        chunks.push(cur)
        cur = []
        curLen = 0
      }
      cur.push({ ...t, piece })
      curLen += piece.length
    }
    if (cur.length) chunks.push(cur)

    const workDir = path.join(vault, 'work', p.id)
    fs.rmSync(workDir, { recursive: true, force: true })
    fs.mkdirSync(workDir, { recursive: true })

    const manifest = { sessionId: p.id, source: p.slug, title: p.meta.title, chunks: [] }
    chunks.forEach((c, i) => {
      const body = c.map((x) => '### ' + fmtTime(x.time) + ' · ' + (x.role === 'user' ? '用户' : '助手') + '\n\n' + x.text + '\n').join('\n')
      const name = 'chunk-' + String(i + 1).padStart(2, '0') + '.md'
      const head = '# ' + (p.meta.title || p.id) + '（第 ' + (i + 1) + '/' + chunks.length + ' 段）\n\n'
      writeText(path.join(workDir, name), head + body)
      manifest.chunks.push({ file: name, chars: body.length, turns: c.length })
    })
    writeJson(path.join(workDir, 'manifest.json'), manifest)
    writeFileDistillPrompt(path.join(workDir, 'DISTILL_PROMPT.md'), p.meta)
    console.log('✓ ' + p.meta.title + ' → ' + chunks.length + ' 段  ' + workDir)
  }
}

function writeFileDistillPrompt(file, meta) {
  const prompt = `# 记忆提炼任务

你在给「${meta.title}」这段对话做长期记忆。逐段读 \`chunk-*.md\`，只挑**值得一年后还记得**的事。

## 记什么
- 用户是谁：身份、称呼、性格、习惯、喜好、忌讳
- 重要的人和关系：家人、朋友、同事、宠物（名字 + 关系）
- 约定与承诺：说好要做的事、时间点、答应过的话
- 长期项目与进展：正在做的项目、关键决定、为什么这么定
- 反复出现的兴趣与话题
- 用户明确说「记住」的事

## 不记什么
- 寒暄、客套、一次性的问答
- 工具怎么调用、命令怎么敲、代码细节
- 随手可查的通用知识
- 已经过期的临时安排（除非能说明结果）

## 输出格式
只输出一个 JSON 数组，不要解释、不要 markdown 代码块：

[
  {
    "date": "2026-10-25",
    "kind": "fact|preference|event|promise|project|skill",
    "importance": 0.8,
    "tags": ["养鱼", "B站"],
    "text": "用户想养兰寿金鱼，已经在看鱼缸。",
    "quote": "原文依据，20 字以内（可选）"
  }
]

要求：
- \`text\` 用第三人称，主语用「用户」；一句话，80 字以内，能独立看懂
- \`date\` 用这段对话发生的日期（YYYY-MM-DD）
- \`importance\` 0~1：0.9+ 是身份/关系/承诺，0.6~0.8 是项目与偏好，0.3~0.5 是普通事件
- \`tags\` 2~6 个，方便以后检索
- 同一件事只写一条；重复的合并
`
  writeText(file, prompt)
}

/* ------------------------------------------------------------------ */
/* 命令：save-cards                                                    */
/* ------------------------------------------------------------------ */

const KINDS = ['fact', 'preference', 'event', 'promise', 'project', 'skill']

function cmdSaveCards() {
  const vault = vaultDir()
  const file = args.file || args._[1]
  if (!file) throw new Error('用法：memvault save-cards --file cards.json [--source slug] [--session sid]')
  const abs = path.resolve(file)
  if (!exists(abs)) throw new Error('文件不存在：' + abs)
  let incoming = readJson(abs, null)
  if (incoming && Array.isArray(incoming.cards)) incoming = incoming.cards
  if (!Array.isArray(incoming)) throw new Error('卡片文件必须是 JSON 数组，或 {cards:[...]}')

  const idx = loadIndex(vault)
  const data = loadCards(vault)
  const sourceSlug = args.source ? String(args.source) : null
  const sessionId = args.session ? String(args.session) : null

  let added = 0
  let dup = 0
  let bad = 0
  for (const raw of incoming) {
    if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) {
      bad++
      continue
    }
    const source = raw.source || sourceSlug
    const session = raw.session || sessionId
    if (!source) {
      bad++
      continue
    }
    const meta = idx.sources[source] && session ? idx.sources[source].sessions[session] : null
    const text = raw.text.trim().replace(/\s+/g, ' ')
    if (text.length < 4) {
      bad++
      continue
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date || '') ? raw.date : meta ? fmtDate(meta.lastAt) : today()
    const kind = KINDS.includes(raw.kind) ? raw.kind : 'event'
    const importance = Math.max(0, Math.min(1, Number(raw.importance) || 0.5))
    const tags = Array.isArray(raw.tags)
      ? raw.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
      : []
    const card = {
      id: 'm' + date.replace(/-/g, '') + '-' + shortHash(text + source).slice(0, 4),
      source,
      sourceTitle: idx.sources[source] ? idx.sources[source].title : source,
      session: session || null,
      date,
      kind,
      importance,
      tags,
      text,
      quote: raw.quote ? truncate(String(raw.quote), 60) : '',
      createdAt: nowIso(),
    }
    if (data.cards.some((c) => c.id === card.id || similar(c.text, text) >= 0.9)) {
      dup++
      continue
    }
    data.cards.push(card)
    added++
  }
  saveCards(vault, data)
  console.log('记忆卡片：新增 ' + added + ' 条，重复 ' + dup + ' 条，无效 ' + bad + ' 条。')
  console.log('库内共 ' + data.cards.length + ' 条。')
}

function bigrams(s) {
  const clean = String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
  const out = new Set()
  for (const seg of clean.split(/\s+/)) {
    if (!seg) continue
    if (/^[\x00-\x7f]+$/.test(seg)) {
      out.add(seg)
      continue
    }
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2))
    if (seg.length === 1) out.add(seg)
  }
  return out
}

function similar(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

/* ------------------------------------------------------------------ */
/* 命令：search                                                        */
/* ------------------------------------------------------------------ */

function cmdSearch() {
  const vault = vaultDir()
  const data = loadCards(vault)
  const q = args._.slice(1).join(' ').trim()
  const tags = String(args.tags || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!q && !tags.length) throw new Error('用法：memvault search 关键词  [--tags 养鱼,B站] [--source slug] [--limit 20]')

  const qTokens = [...bigrams(q)]
  const df = new Map()
  for (const c of data.cards) {
    const toks = new Set([...bigrams(c.text), ...(c.tags || []).map((t) => String(t).toLowerCase())])
    for (const t of new Set([...qTokens, ...toks])) df.set(t, (df.get(t) || 0) + 0)
    for (const t of qTokens) if (toks.has(t)) df.set(t, (df.get(t) || 0) + 1)
  }
  const N = Math.max(1, data.cards.length)

  let rows = []
  for (const c of data.cards) {
    if (args.source && c.source !== String(args.source)) continue
    if (tags.length && !tags.every((t) => (c.tags || []).some((x) => String(x).toLowerCase().includes(t.toLowerCase())))) continue
    let score = 0
    const text = String(c.text).toLowerCase()
    const cTags = (c.tags || []).map((t) => String(t).toLowerCase())
    for (const t of qTokens) {
      const inText = text.includes(t)
      const inTag = cTags.some((x) => x.includes(t))
      if (!inText && !inTag) continue
      const idf = Math.log(1 + N / Math.max(1, df.get(t) || 0))
      score += idf * (inText ? 1 : 0.6) * (inTag ? 1.6 : 1)
    }
    if (q && text.includes(q.toLowerCase())) score += 3
    for (const t of tags) if (cTags.includes(t.toLowerCase())) score += 2
    if (score <= 0 && (q || tags.length)) continue
    const age = Math.max(0, (Date.now() - Date.parse(c.date)) / 86400000)
    score += (c.importance || 0.5) * 0.4 + Math.max(0, 1 - age / 365) * 0.3
    rows.push({ c, score })
  }
  rows.sort((a, b) => b.score - a.score || b.c.importance - a.c.importance)
  const limit = Math.max(1, Number(args.limit) || 20)
  rows = rows.slice(0, limit)

  if (flag('json')) {
    console.log(JSON.stringify(rows.map((r) => ({ score: Number(r.score.toFixed(3)), ...r.c })), null, 2))
    return
  }

  if (!rows.length) {
    console.log('没有找到相关记忆。')
  } else {
    console.log('找到 ' + rows.length + ' 条（按相关度）：\n')
    rows.forEach(({ c, score }, i) => {
      console.log(
        String(i + 1).padStart(2) + '. [' + score.toFixed(2) + '] ' + c.date + ' · ' + kindName(c.kind) + ' · 重要 ' + c.importance.toFixed(1),
      )
      console.log('    ' + c.text)
      console.log('    #' + (c.tags || []).join(' #') + '   ' + c.id + '  ← ' + (c.sourceTitle || c.source))
      console.log('')
    })
    console.log('挑选后：memvault keep <id...>   （或在 vault/review.html 里勾选）')
  }

  if (flag('deep')) deepSearch(vault, q, tags)
}

function deepSearch(vault, q, tags) {
  if (!q) return
  console.log('\n—— 原文里也搜一下 ——\n')
  const root = path.join(vault, 'sources')
  let hits = 0
  const walk = (dir) => {
    let ents = []
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'transcript.md') {
        const lines = fs.readFileSync(p, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (hits >= 30) return
          if (line.includes(q)) {
            hits++
            console.log('- ' + path.relative(vault, p) + ':' + (i + 1))
            console.log('  ' + truncate(line.trim(), 160))
          }
        })
      }
    }
  }
  walk(root)
  if (!hits) console.log('（原文里没有命中）')
}

function kindName(k) {
  return (
    {
      fact: '事实',
      preference: '偏好',
      event: '事件',
      promise: '约定',
      project: '项目',
      skill: '技能',
    }[k] || k
  )
}

/* ------------------------------------------------------------------ */
/* 命令：review                                                        */
/* ------------------------------------------------------------------ */

function cmdReview() {
  const vault = vaultDir()
  const data = loadCards(vault)
  const cards = data.cards.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.importance - a.importance))
  const sources = [...new Set(cards.map((c) => c.source))]
  const html = reviewHtml(cards, sources)
  const out = path.join(vault, 'review.html')
  writeText(out, html)
  console.log('已生成勾选页：' + out)
  console.log('共 ' + cards.length + ' 条。勾完点「复制选中 ID」，回来跑：memvault keep <粘贴的 ID>')
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function reviewHtml(cards, sources) {
  const rows = cards
    .map(
      (c) => `<label class="card" data-source="${esc(c.source)}" data-kind="${esc(c.kind)}">
  <input type="checkbox" value="${esc(c.id)}">
  <div class="body">
    <div class="meta"><span class="date">${esc(c.date)}</span><span class="kind">${esc(kindName(c.kind))}</span><span class="imp">${esc(c.importance.toFixed(1))}</span><span class="src">${esc(c.sourceTitle || c.source)}</span></div>
    <div class="text">${esc(c.text)}</div>
    <div class="tags">${(c.tags || []).map((t) => '<span>#' + esc(t) + '</span>').join('')}</div>
  </div>
</label>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆方舟 · 挑记忆</title>
<style>
  :root{--bg:#0f1419;--panel:#171d25;--line:#2a3341;--text:#e6edf3;--dim:#8b98a9;--acc:#58a6ff;--ok:#3fb950}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif}
  header{position:sticky;top:0;z-index:5;background:rgba(15,20,25,.94);backdrop-filter:blur(6px);border-bottom:1px solid var(--line);padding:14px 18px}
  h1{font-size:18px;margin:0 0 10px;font-weight:600}
  .controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  input[type=search],select{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:7px 10px;font:inherit;outline:none}
  input[type=search]{min-width:260px;flex:1}
  button{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:7px 12px;font:inherit;cursor:pointer}
  button:hover{border-color:var(--acc)}
  button.primary{background:#1f6feb;border-color:#1f6feb}
  main{padding:16px 18px 120px;max-width:980px;margin:0 auto}
  .card{display:flex;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 10px;cursor:pointer}
  .card:hover{border-color:#3d4a5c}
  .card input{margin-top:4px;width:18px;height:18px;accent-color:var(--acc);flex:none}
  .card .body{flex:1;min-width:0}
  .meta{display:flex;gap:10px;font-size:12px;color:var(--dim);margin-bottom:4px;flex-wrap:wrap}
  .kind{color:var(--acc)}
  .text{font-size:15px}
  .tags{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}
  .tags span{font-size:12px;color:var(--dim)}
  .bar{position:fixed;left:0;right:0;bottom:0;background:rgba(15,20,25,.96);border-top:1px solid var(--line);padding:12px 18px;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap}
  .count{color:var(--dim)}
  .count b{color:var(--ok)}
  #out{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);width:min(860px,92vw);height:90px;background:#0b0f14;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px;display:none;font:12px/1.4 monospace}
  .hint{color:var(--dim);font-size:12px;text-align:center;margin-top:8px}
</style>
</head>
<body>
<header>
  <h1>🐋 记忆方舟 · 挑出要带走的记忆</h1>
  <div class="controls">
    <input id="q" type="search" placeholder="搜内容 / 标签…">
    <select id="src"><option value="">全部工作区</option>${sources.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
    <select id="kind"><option value="">全部类型</option>${['fact', 'preference', 'event', 'promise', 'project', 'skill'].map((k) => `<option value="${k}">${esc(kindName(k))}</option>`).join('')}</select>
    <button id="all">全选可见</button>
    <button id="none">清空</button>
  </div>
</header>
<main id="list">
${rows}
</main>
<textarea id="out" readonly></textarea>
<div class="bar">
  <span class="count">已选 <b id="n">0</b> 条 / 共 ${cards.length} 条</span>
  <button id="copy" class="primary">复制选中 ID</button>
  <button id="download">下载 selection.json</button>
</div>
<div class="hint">勾完复制，回到 DSH 里跑：<code>memvault keep &lt;ID...&gt;</code>；也可以下载 JSON 后 <code>memvault keep --selection 文件</code></div>
<script>
const cards=[...document.querySelectorAll('.card')];
const q=document.getElementById('q'),src=document.getElementById('src'),kind=document.getElementById('kind');
function visible(c){const t=c.querySelector('.text').textContent.toLowerCase();const tags=[...c.querySelectorAll('.tags span')].map(x=>x.textContent).join(' ').toLowerCase();return (!q.value||(t+' '+tags).includes(q.value.toLowerCase()))&&(!src.value||c.dataset.source===src.value)&&(!kind.value||c.dataset.kind===kind.value)}
function refresh(){cards.forEach(c=>{c.style.display=visible(c)?'':'none'});count()}
function selected(){return [...document.querySelectorAll('.card input:checked')].map(x=>x.value)}
function count(){document.getElementById('n').textContent=selected().length}
q.oninput=refresh;src.onchange=refresh;kind.onchange=refresh;
document.getElementById('all').onclick=()=>{cards.forEach(c=>{if(visible(c))c.querySelector('input').checked=true});count()};
document.getElementById('none').onclick=()=>{cards.forEach(c=>c.querySelector('input').checked=false);count()};
document.getElementById('list').onchange=count;
document.getElementById('copy').onclick=async()=>{const ids=selected();const out=document.getElementById('out');out.style.display='block';out.value=ids.join(' ');out.select();try{await navigator.clipboard.writeText(ids.join(' '))}catch(e){document.execCommand('copy')}};
document.getElementById('download').onclick=()=>{const blob=new Blob([JSON.stringify({ids:selected()},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='selection.json';a.click();URL.revokeObjectURL(a.href)};
</script>
</body>
</html>`
}

/* ------------------------------------------------------------------ */
/* 命令：keep                                                          */
/* ------------------------------------------------------------------ */

async function cmdKeep() {
  const vault = vaultDir()
  const data = loadCards(vault)
  let ids = args._.slice(1)
  if (args.selection) {
    const sel = readJson(path.resolve(String(args.selection)), null)
    if (sel && Array.isArray(sel.ids)) ids = sel.ids
  }
  if (args.ids) ids = String(args.ids).split(/[,，\s]+/).filter(Boolean)
  if (!ids.length) throw new Error('用法：memvault keep <id...> [--session sid] [--no-fish]')

  const picked = []
  const missing = []
  const seen = new Set()
  for (const want of ids) {
    const c = data.cards.find((x) => x.id === want) || data.cards.find((x) => x.id.startsWith(want))
    if (c) {
      if (!seen.has(c.id)) {
        seen.add(c.id)
        picked.push(c)
      }
    } else missing.push(want)
  }
  if (!picked.length) throw new Error('一个都没找到：' + missing.join(', '))

  const ws = currentWorkspace()
  const target = flag('workspace') ? path.resolve(String(args.workspace)) : ws.path
  const session = args.session ? String(args.session) : latestSession(ws)
  let memFile = null
  if (!flag('no-memory')) {
    memFile = path.join(target, 'MEMORY.md')
    writeMemoryFile(memFile, picked)
  }

  let fish = { tried: 0, added: 0, dup: 0, failed: 0, enabled: false, skipped: true }
  if (!flag('no-fish') && session) {
    fish = { tried: 0, added: 0, dup: 0, failed: 0, enabled: false, skipped: false }
    const base = String(args['fish-url'] || process.env.DSH_WEB_URL || 'http://127.0.0.1:52467').replace(/\/+$/, '')
    let pluginUp = false
    try {
      await fetchJson(base + '/dsh-fish-memory/toggle', { session, on: true })
      pluginUp = true
      fish.enabled = true
    } catch {
      // 插件没装/服务没开：连一次都不试，免得刷一屏失败
      fish.skipped = true
    }
    if (pluginUp) {
      for (const c of picked) {
        fish.tried++
        try {
          const r = await fetchJson(base + '/dsh-fish-memory/add', {
            session,
            text: c.text,
            at: c.date,
            importance: c.importance,
            tags: c.tags,
          })
          if (r && r.ok) fish.added++
          else fish.dup++
        } catch {
          fish.failed++
        }
      }
    }
  }

  const logDir = path.join(vault, 'keeps')
  const logFile = path.join(logDir, new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23) + '.json')
  writeJson(logFile, {
    at: nowIso(),
    workspace: target,
    session,
    ids: picked.map((c) => c.id),
    cards: picked.map((c) => ({ id: c.id, text: c.text })),
    fish,
  })

  console.log('🐋 已提取 ' + picked.length + ' 条记忆' + (missing.length ? '（' + missing.length + ' 条没找到）' : '') + '。')
  if (memFile) console.log('  ✓ 写入 ' + memFile)
  if (!fish.skipped) {
    console.log('  ✓ 鱼的记忆：新增 ' + fish.added + '，重复 ' + fish.dup + '，失败 ' + fish.failed + (fish.enabled ? '（已为会话打开记忆）' : ''))
  } else if (flag('no-fish')) {
    console.log('  · 跳过「鱼的记忆」（--no-fish）')
  } else if (!session) {
    console.log('  · 目标工作区还没有会话（先开一个会话再提取，或加 --session）')
  } else {
    console.log('  · 鱼的记忆没连上（没装或 DSH 没开），只写了 MEMORY.md')
  }
  console.log('  记录：' + logFile)
}

function latestSession(ws) {
  const files = sessionFileMap()
  let best = null
  for (const sid of ws.sessionIds || []) {
    const f = files.get(sid)
    if (!f) continue
    try {
      const m = fs.statSync(f).mtimeMs
      if (!best || m > best.m) best = { sid, m }
    } catch {
      // ignore
    }
  }
  return best ? best.sid : null
}

function writeMemoryFile(file, cards) {
  const start = '<!-- memvault:start -->'
  const end = '<!-- memvault:end -->'
  const stamp = fmtTime(Date.now())
  const body = cards
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((c) => {
      const tags = (c.tags || []).map((t) => '`#' + t + '`').join(' ')
      return '- ' + c.date + ' · **' + kindName(c.kind) + '** · ' + c.text + (tags ? ' ' + tags : '') + '  <!-- ' + c.id + ' -->'
    })
    .join('\n')
  const block = `${start}
## 记忆方舟 · 提取于 ${stamp}

> 这些是跨工作区带过来的长期记忆，来自记忆库；由 \`memvault keep\` 维护，手改不会被覆盖，重新提取会整块更新。

${body}
${end}`

  let old = ''
  try {
    old = fs.readFileSync(file, 'utf8')
  } catch {
    old = ''
  }
  let next
  if (old.includes(start) && old.includes(end)) {
    next = old.replace(new RegExp(start + '[\\s\\S]*?' + end), block)
  } else {
    next = old.trimEnd() + (old.trim() ? '\n\n' : '') + block + '\n'
  }
  writeText(file, next)
}

async function fetchJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  if (!res.ok && !(json && json.ok === false)) throw new Error('HTTP ' + res.status)
  return json || { ok: res.ok }
}

/* ------------------------------------------------------------------ */
/* 命令：status / doctor / mirror                                      */
/* ------------------------------------------------------------------ */

function cmdStatus() {
  const vault = vaultDir()
  const idx = loadIndex(vault)
  const data = loadCards(vault)
  console.log('🐋 记忆方舟')
  console.log('  记忆库：' + vault)
  console.log('  已备份工作区：' + Object.keys(idx.sources).length)
  let sessions = 0
  let bytes = 0
  for (const [slug, s] of Object.entries(idx.sources)) {
    const n = Object.keys(s.sessions).length
    sessions += n
    console.log('  - ' + s.title + '  ' + n + ' 个会话  最近备份 ' + (s.lastBackupAt ? fmtTime(s.lastBackupAt) : '—'))
    for (const meta of Object.values(s.sessions)) bytes += meta.chars || 0
  }
  console.log('  会话总数：' + sessions + ' · 正文约 ' + (bytes / 10000).toFixed(1) + ' 万字')
  console.log('  记忆卡片：' + data.cards.length + ' 条')
  const last = Object.values(idx.sources)
    .map((s) => s.lastBackupAt)
    .filter(Boolean)
    .sort()
    .pop()
  console.log('  最近一次备份：' + (last ? fmtTime(last) : '还没备份过'))
  console.log('  勾选页：' + path.join(vault, 'review.html') + (exists(path.join(vault, 'review.html')) ? '' : '（还没生成）'))
}

async function cmdDoctor() {
  const vault = vaultDir()
  console.log('🐋 记忆方舟 · 自检')
  console.log('  DSH 家目录：' + DSH_HOME + (exists(DSH_HOME) ? '  ✓' : '  ✖ 不存在'))
  console.log('  Node：' + process.version + (typeof zlib.zstdDecompressSync === 'function' ? '  ✓ 支持 zstd' : '  ✖ 不支持 zstd'))
  const reg = loadRegistry()
  console.log('  已注册工作区：' + reg.length + ' 个')
  const files = sessionFileMap()
  console.log('  可读会话文件：' + files.size + ' 个')
  console.log('  记忆库：' + vault)
  try {
    fs.mkdirSync(vault, { recursive: true })
    const probe = path.join(vault, '.probe')
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe)
    console.log('  记忆库可写：✓')
  } catch (e) {
    console.log('  记忆库可写：✖ ' + e.message)
  }
  try {
    const base = String(args['fish-url'] || process.env.DSH_WEB_URL || 'http://127.0.0.1:52467').replace(/\/+$/, '')
    const res = await fetch(base + '/dsh-fish-memory/list', { signal: AbortSignal.timeout(5000) })
    console.log('  「鱼的记忆」插件：' + (res.ok ? '✓ 可用' : '✖ HTTP ' + res.status))
  } catch {
    console.log('  「鱼的记忆」插件：· 没连上（不影响备份，只是提取时不会自动写进插件）')
  }
}

function cmdMirror() {
  const vault = vaultDir()
  if (!args.to) throw new Error('用法：memvault mirror --to D:\\backup\\memory-vault')
  const to = path.resolve(String(args.to))
  const skip = new Set(['work', 'node_modules'])
  const copy = (rel) => {
    const src = path.join(vault, rel)
    const dst = path.join(to, rel)
    const st = fs.statSync(src)
    if (st.isDirectory()) {
      if (skip.has(path.basename(rel))) return
      fs.mkdirSync(dst, { recursive: true })
      for (const n of fs.readdirSync(src)) copy(path.join(rel, n))
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
    }
  }
  copy('')
  console.log('已镜像到：' + to)
}

/* ------------------------------------------------------------------ */
/* 帮助                                                                */
/* ------------------------------------------------------------------ */

function usage() {
  console.log(`🐋 记忆方舟 memvault

  备份（一次只备份一个会话；整个工作区用 --all）
    memvault workspaces
    memvault sessions --workspace-id <UUID>   列出这个工作区的会话和序号
    memvault backup --workspace-id <UUID> --session <序号|会话id>
    memvault backup --workspace-id <UUID> --all
    memvault backup <工作区名|代号|工作区ID> --session <序号|会话id>
    memvault backup --from-session <会话id>   反查它属于哪个工作区，只备这一条
    memvault backup --workspace <路径> --session <序号|会话id>
    memvault backup --source <代号|工作区ID> --session <序号|会话id>
    memvault backup --here --session <序号|会话id>
    以上都可加 --dry-run 预览；--force 强制重做
    memvault status [--vault <路径>]

  提炼（模型做，人挑）
    memvault chunks --source <slug> [--session <id>] [--chars 24000]
    memvault save-cards --file cards.json --source <slug> [--session <id>]

  取用（在目标工作区里跑）
    memvault search 关键词 [--tags 养鱼,B站] [--source slug] [--limit 20] [--deep] [--json]
    memvault review
    memvault keep <id...> [--session <id>] [--no-fish] [--selection selection.json]

  搬运
    memvault mirror --to <目录>
    memvault doctor

  默认记忆库：${DEFAULT_VAULT}
  DSH 家目录：${DSH_HOME}
`)
}

try {
  await main()
} catch (e) {
  console.error('✖ ' + (e && e.message ? e.message : e))
  process.exit(1)
}