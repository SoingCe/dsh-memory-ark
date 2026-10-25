/**
 * dsh-memory-ark — 记忆方舟 · 定时备份
 *
 * 宿主半边：每天到点，把「指定工作区里的指定会话」备份进 memvault 记忆库。
 *
 * 设计：
 *   - 配置存在 ~/.dsh/memory-ark/config.json，状态在 state.json，日志在 run.log；
 *   - 每 30 秒检查一次「最近一次应该跑的时间」有没有跑过；
 *   - DSH 关着时跑不了，但下次打开会补跑最近错过的那一次（due 取最近一个已到的时间点）；
 *   - 真正的备份交给 memvault.mjs，不重复实现一套；
 *   - 设置页在 /dsh-memory-ark/page（宿主 HTTP 路由，不需要客户端打包）。
 */

import { spawn } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join, dirname, basename, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { PAGE_HTML } from './page.js'

export const name = 'dsh-memory-ark'
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const ARK_DIR = process.env.MEMORY_ARK_DIR || join(DSH_HOME, 'memory-ark')
const CONFIG_FILE = join(ARK_DIR, 'config.json')
const STATE_FILE = join(ARK_DIR, 'state.json')
const LOG_FILE = join(ARK_DIR, 'run.log')
const DEFAULT_AT = '23:30'
const TICK_MS = 30_000

let running = false
let picking = false

const WIN_PICK_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '选择记忆库目录'
$d.ShowNewFolderButton = $true
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($d.SelectedPath))
}
`

function psEncoded(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
/* ------------------------------------------------------------------ */

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  } catch {
    /* 写不了就算了，不能把宿主搞挂 */
  }
}

function guessMemvault() {
  // ① 显式指定优先：换机器、记忆库不在默认位置时，设这个环境变量最省事。
  const explicit = process.env.MEMORY_ARK_MEMVAULT
  if (explicit && existsSync(explicit)) return explicit

  const candidates = []
  // ② 已登记的工作区（DSH 里加过的那些）——最常见的情况就是记忆库在某个工作区里。
  try {
    for (const w of loadRegistry()) {
      if (w.path) candidates.push(join(w.path, 'memory-vault', 'memvault.mjs'))
    }
  } catch {
    /* ignore */
  }
  // ③ 插件自带的副本：只装插件、没单独放记忆库的人靠这一份就能跑。
  candidates.push(join(HERE, 'memory-vault', 'memvault.mjs'))
  // ③ 老式布局：Documents\deepseek-harness\<任意目录>\memory-vault\memvault.mjs
  const docs = join(homedir(), 'Documents', 'deepseek-harness')
  candidates.push(join(docs, 'default-workspace', 'memory-vault', 'memvault.mjs'))
  candidates.push(join(HERE, '..', '..', 'memory-vault', 'memvault.mjs'))
  try {
    for (const d of readdirSync(docs)) candidates.push(join(docs, d, 'memory-vault', 'memvault.mjs'))
  } catch {
    /* ignore */
  }
  return candidates.find((p) => existsSync(p)) || ''
}

/** 这个 memvault 是从插件包里带出来的那份吗（而不是用户工作区里那份）。 */
function isBundledMemvault(p) {
  return resolve(p) === resolve(join(HERE, 'memory-vault', 'memvault.mjs'))
}

function defaultConfig() {
  const mv = guessMemvault()
  return {
    enabled: false,
    workspaceId: '',
    workspaceTitle: '',
    sessionId: '',
    sessionTitle: '',
    at: DEFAULT_AT,
    memvaultPath: mv,
    // 打包自带的那份 memvault 旁边不能放库（node_modules 会被 pnpm 重装冲掉），
    // 这种情况默认写到 ~/.dsh/memory-ark/vault。
    vaultPath: mv ? join(isBundledMemvault(mv) ? ARK_DIR : dirname(mv), 'vault') : '',
    nodePath: '',
  }
}

function loadConfig() {
  const raw = readJson(CONFIG_FILE, null)
  const cfg = { ...defaultConfig(), ...(raw || {}) }
  if (!/^\d{1,2}:\d{2}$/.test(String(cfg.at || ''))) cfg.at = DEFAULT_AT
  return cfg
}

function saveConfig(cfg) {
  writeJson(CONFIG_FILE, cfg)
}

function loadState() {
  return readJson(STATE_FILE, { lastRunKey: '', lastRunAt: 0, lastResult: null })
}

function saveState(state) {
  writeJson(STATE_FILE, state)
}

function appendLog(text) {
  try {
    mkdirSync(ARK_DIR, { recursive: true })
    appendFileSync(LOG_FILE, text + '\n', 'utf8')
    if (statSync(LOG_FILE).size > 512 * 1024) {
      const buf = readFileSync(LOG_FILE)
      writeFileSync(LOG_FILE, buf.subarray(Math.max(0, buf.length - 256 * 1024)))
    }
  } catch {
    /* ignore */
  }
}

function loadRegistry() {
  const j = readJson(join(DSH_HOME, 'storages', 'workspace.json'), {})
  const t = (j.tables && j.tables.workspaces) || {}
  return Object.entries(t).map(([id, w]) => ({
    id,
    title: w.title || basename(w.path || ''),
    path: w.path || '',
    sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds : [],
  }))
}

function slugify(p) {
  const base = basename(p).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
  return base + '-' + createHash('sha1').update(resolve(p).toLowerCase()).digest('hex').slice(0, 6)
}

function sessionFileOf(sid) {
  const root = join(DSH_HOME, 'sessions')
  try {
    for (const bucket of readdirSync(root)) {
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const f = join(root, bucket, sid, name)
        if (existsSync(f)) return f
      }
    }
  } catch {
    /* ignore */
  }
  return ''
}

function nodeExe(cfg) {
  if (cfg && cfg.nodePath && existsSync(cfg.nodePath)) return cfg.nodePath
  const root = join(DSH_HOME, 'dsh-runtimes')
  try {
    for (const d of readdirSync(root)) {
      const p = join(root, d, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
      if (existsSync(p)) return p
    }
  } catch {
    /* ignore */
  }
  return 'node'
}

function exec(cmd, args, { cwd, timeout = 300_000 } = {}) {
  return new Promise((resolve) => {
    let child
    let done = false
    let timer = null
    let out = ''
    let err = ''
    const finish = (r) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true })
    } catch (e) {
      finish({ code: -1, stdout: '', stderr: String((e && e.message) || e) })
      return
    }
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ code: -1, stdout: out, stderr: err + '\n（超时）' })
    }, timeout)
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', (e) => finish({ code: -1, stdout: out, stderr: err + String((e && e.message) || e) }))
    child.on('close', (code) => finish({ code, stdout: out, stderr: err }))
  })
}

function dueAt(at, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || DEFAULT_AT))
  const h = m ? Math.min(23, Math.max(0, Number(m[1]))) : 23
  const min = m ? Math.min(59, Math.max(0, Number(m[2]))) : 30
  const d = new Date(now)
  d.setHours(h, min, 0, 0)
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1)
  return d.getTime()
}

function nextDue(at, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || DEFAULT_AT))
  const h = m ? Math.min(23, Math.max(0, Number(m[1]))) : 23
  const min = m ? Math.min(59, Math.max(0, Number(m[2]))) : 30
  const d = new Date(now)
  d.setHours(h, min, 0, 0)
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  return d.getTime()
}

function listSessions(workspaceId) {
  const cfg = loadConfig()
  const ws = loadRegistry().find((w) => w.id === workspaceId)
  if (!ws) throw new Error('没有这个工作区')
  const slug = slugify(ws.path)
  const out = []
  for (const sid of ws.sessionIds) {
    const file = sessionFileOf(sid)
    if (!file) continue
    let st
    try {
      st = statSync(file)
    } catch {
      continue
    }
    const meta = readJson(join(cfg.vaultPath || '', 'sources', slug, 'sessions', sid, 'meta.json'), null)
    out.push({
      id: sid,
      title: (meta && meta.title) || sid,
      messages: meta ? (meta.userMessages || 0) + (meta.assistantMessages || 0) : 0,
      bytes: st.size,
      lastAt: (meta && meta.lastAt) || st.mtimeMs,
      mtime: st.mtimeMs,
      backedUp: !!meta,
    })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/* ------------------------------------------------------------------ */
/* 备份                                                                 */
/* ------------------------------------------------------------------ */

async function runBackup(cfg, trigger) {
  if (running) return { ok: false, at: Date.now(), trigger, output: '上一次备份还没跑完，稍等。' }
  running = true
  const started = Date.now()
  const args = [
    cfg.memvaultPath,
    'backup',
    '--workspace-id',
    cfg.workspaceId,
    '--session',
    cfg.sessionId,
  ]
  if (cfg.vaultPath) args.push('--vault', cfg.vaultPath)

  let r
  try {
    r = await exec(nodeExe(cfg), args, { cwd: dirname(cfg.memvaultPath), timeout: 600_000 })
  } finally {
    running = false
  }
  const output = ((r.stdout || '') + (r.stderr || '')).trim()
  const result = {
    ok: r.code === 0,
    code: r.code,
    at: started,
    trigger,
    workspaceId: cfg.workspaceId,
    sessionId: cfg.sessionId,
    output: output.slice(-4000),
  }
  const due = dueAt(cfg.at)
  saveState({
    lastRunKey: due + '|' + cfg.workspaceId + '|' + cfg.sessionId,
    lastRunAt: started,
    lastResult: result,
  })
  appendLog('[' + new Date(started).toISOString() + '] ' + trigger + ' ' + (result.ok ? 'OK' : 'FAIL') + ' code=' + r.code + '\n' + output + '\n')
  return result
}

async function checkDue() {
  const cfg = loadConfig()
  if (!cfg.enabled || !cfg.workspaceId || !cfg.sessionId || !cfg.memvaultPath) return
  if (!existsSync(cfg.memvaultPath)) return
  const due = dueAt(cfg.at)
  const key = due + '|' + cfg.workspaceId + '|' + cfg.sessionId
  if (loadState().lastRunKey === key) return
  await runBackup(cfg, 'auto')
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                 */
/* ------------------------------------------------------------------ */

function sendJson(res, code, data) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(data))
}

async function readBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 1_000_000) break
  }
  return body
}

function statusPayload() {
  const cfg = loadConfig()
  return {
    ok: true,
    config: cfg,
    state: loadState(),
    nextDue: cfg.enabled ? nextDue(cfg.at) : null,
    now: Date.now(),
    paths: { config: CONFIG_FILE, log: LOG_FILE, ark: ARK_DIR },
  }
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                             */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  mkdirSync(ARK_DIR, { recursive: true })
  if (!existsSync(CONFIG_FILE)) saveConfig(defaultConfig())

  const web = ctx.webServer
  const route = (path, handler) => {
    ctx.effect(() => web.register({ path, handler }), 'dsh-memory-ark: ' + path)
  }

  route('/dsh-memory-ark/page', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE_HTML)
  })

  route('/dsh-memory-ark/status', (req, res) => {
    sendJson(res, 200, statusPayload())
  })

  route('/dsh-memory-ark/workspaces', (req, res) => {
    const workspaces = loadRegistry().map((w) => ({
      id: w.id,
      title: w.title,
      path: w.path,
      sessionCount: w.sessionIds.length,
    }))
    sendJson(res, 200, { ok: true, workspaces })
  })

  route('/dsh-memory-ark/sessions', async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const workspaceId = url.searchParams.get('workspaceId') || ''
      if (!workspaceId) return sendJson(res, 400, { ok: false, error: '缺 workspaceId' })
      const sessions = await listSessions(workspaceId)
      sendJson(res, 200, { ok: true, sessions })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  })

  route('/dsh-memory-ark/save', async (req, res) => {
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      const workspaces = loadRegistry()
      const ws = workspaces.find((w) => w.id === String(body.workspaceId || ''))
      if (!ws) return sendJson(res, 400, { ok: false, error: '没有这个工作区' })
      const sessionId = String(body.sessionId || '')
      if (!ws.sessionIds.includes(sessionId)) return sendJson(res, 400, { ok: false, error: '这个会话不属于该工作区' })
      if (!/^\d{1,2}:\d{2}$/.test(String(body.at || ''))) return sendJson(res, 400, { ok: false, error: '时间格式要 HH:MM' })
      let memvaultPath = String(body.memvaultPath || '').trim()
      if (!memvaultPath) memvaultPath = guessMemvault()
      if (!memvaultPath || !existsSync(memvaultPath)) return sendJson(res, 400, { ok: false, error: 'memvault.mjs 路径不存在' })

      const wantVault = String(body.vaultPath || '').trim()
      const vaultPath = wantVault || join(dirname(memvaultPath), 'vault')
      if (!isAbsolute(vaultPath)) return sendJson(res, 400, { ok: false, error: '记忆库目录要写绝对路径' })
      try {
        mkdirSync(vaultPath, { recursive: true })
        if (!statSync(vaultPath).isDirectory()) throw new Error('不是目录')
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: '记忆库目录不可用：' + String((e && e.message) || e) })
      }

      const cfg = loadConfig()
      const next = {
        ...cfg,
        enabled: !!body.enabled,
        workspaceId: ws.id,
        workspaceTitle: ws.title,
        sessionId,
        sessionTitle: '',
        at: String(body.at),
        memvaultPath,
        vaultPath,
      }
      saveConfig(next)
      sendJson(res, 200, { ...statusPayload(), config: next })
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String((e && e.message) || e) })
    }
  })

  route('/dsh-memory-ark/run', async (req, res) => {
    try {
      const cfg = loadConfig()
      if (!cfg.memvaultPath || !cfg.workspaceId || !cfg.sessionId) {
        return sendJson(res, 400, { ok: false, error: '还没选工作区/会话' })
      }
      const result = await runBackup(cfg, 'manual')
      sendJson(res, 200, { ok: true, result, status: statusPayload() })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  })

  route('/dsh-memory-ark/pick-folder', async (req, res) => {
    try {
      if (process.env.MEMORY_ARK_PICK_STUB) {
        return sendJson(res, 200, { ok: true, path: process.env.MEMORY_ARK_PICK_STUB })
      }
      if (process.platform !== 'win32') {
        return sendJson(res, 501, { ok: false, error: '当前系统不支持弹系统文件夹选择窗口' })
      }
      if (picking) return sendJson(res, 409, { ok: false, error: '已经有一个选择窗口开着' })

      picking = true
      try {
        const r = await exec(
          'powershell.exe',
          ['-NoProfile', '-STA', '-EncodedCommand', psEncoded(WIN_PICK_SCRIPT)],
          { timeout: 600_000 },
        )
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'powershell 退出码 ' + r.code).trim().slice(-400))
        const line = String(r.stdout || '')
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .pop()
        if (!line) return sendJson(res, 200, { ok: true, cancelled: true })
        const picked = Buffer.from(line, 'base64').toString('utf8').trim()
        if (!picked) return sendJson(res, 200, { ok: true, cancelled: true })
        sendJson(res, 200, { ok: true, path: picked })
      } finally {
        picking = false
      }
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  })

  route('/dsh-memory-ark/log', (req, res) => {
    try {
      const text = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8').slice(-20_000) : '（还没有日志）'
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(String((e && e.message) || e))
    }
  })

  // 定时检查：30 秒一次；启动 5 秒后先补一次
  ctx.effect(() => {
    const timer = setInterval(() => {
      checkDue().catch(() => {})
    }, TICK_MS)
    timer.unref?.()
    const first = setTimeout(() => {
      checkDue().catch(() => {})
    }, 5000)
    first.unref?.()
    return () => {
      clearInterval(timer)
      clearTimeout(first)
    }
  }, 'dsh-memory-ark: scheduler')

  console.log('[dsh-memory-ark] 已加载；设置页 /dsh-memory-ark/page；配置 ' + CONFIG_FILE)
}
