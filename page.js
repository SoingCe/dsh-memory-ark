export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆方舟 · 定时备份</title>
<style>
  :root{--bg:#0f1419;--panel:#171d25;--line:#2a3341;--text:#e6edf3;--dim:#8b98a9;--acc:#58a6ff;--ok:#3fb950;--bad:#f85149}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 "Microsoft YaHei",system-ui,sans-serif}
  main{max-width:820px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:var(--dim);font-size:13px;margin-bottom:22px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
  .row{display:flex;gap:12px;align-items:center;margin:12px 0;flex-wrap:wrap}
  .row label{width:100px;color:var(--dim);flex:none}
  .row .grow{flex:1;min-width:240px}
  select,input[type=text],input[type=time]{width:100%;background:#0b0f14;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:8px 10px;font:inherit;outline:none}
  select:focus,input:focus{border-color:var(--acc)}
  .hint{color:var(--dim);font-size:12px;margin-top:2px}
  button{background:#1f6feb;border:1px solid #1f6feb;color:#fff;border-radius:8px;padding:8px 16px;font:inherit;cursor:pointer}
  button.ghost{background:transparent;border-color:var(--line);color:var(--text)}
  button:disabled{opacity:.5;cursor:default}
  .status{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:var(--dim)}
  .status b{color:var(--text);font-weight:600}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dim);margin-right:6px;vertical-align:1px}
  .dot.on{background:var(--ok)}
  .dot.off{background:var(--bad)}
  pre{background:#0b0f14;border:1px solid var(--line);border-radius:8px;padding:10px;font:12px/1.5 Consolas,monospace;white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto;margin:0}
  .note{color:var(--dim);font-size:12px;margin-top:10px}
  .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1f6feb;color:#fff;border-radius:8px;padding:9px 16px;opacity:0;transition:opacity .2s;pointer-events:none;font-size:14px}
  .toast.show{opacity:1}
</style>
</head>
<body>
<main>
  <h1>🐋 记忆方舟 · 定时备份</h1>
  <div class="sub">每天到点把选中的那个会话备份进记忆库。DSH 关着时不会跑，下次打开会补跑最近错过的一次。</div>

  <div class="panel">
    <div class="status">
      <span><span id="dot" class="dot"></span><b id="state">未开启</b></span>
      <span>下次：<b id="next">—</b></span>
      <span>上次：<b id="last">—</b></span>
    </div>
  </div>

  <div class="panel">
    <div class="row">
      <label>工作区</label>
      <div class="grow"><select id="ws"></select><div class="hint">只认 DSH 已注册的工作区</div></div>
    </div>
    <div class="row">
      <label>会话</label>
      <div class="grow"><select id="sess"></select><div class="hint">选中哪个，就只备份哪个会话</div></div>
    </div>
    <div class="row">
      <label>每天几点</label>
      <div class="grow"><input id="at" type="time" value="23:30"><div class="hint">按本机时间；建议 23:30 左右</div></div>
    </div>
    <div class="row">
      <label>开启</label>
      <div class="grow"><label style="width:auto;color:var(--text)"><input id="enabled" type="checkbox" style="accent-color:var(--acc)"> 每天自动备份一次</label></div>
    </div>
    <div class="row">
      <label>memvault.mjs</label>
      <div class="grow"><input id="mv" type="text" placeholder="...\\memory-vault\\memvault.mjs"><div class="hint">记忆库里的 memvault.mjs 路径；留空会尝试自动找</div></div>
    </div>
    <div class="row">
      <label>记忆库目录</label>
      <div class="grow"><input id="vault" type="text" placeholder="留空 = memvault.mjs 旁边的 vault"><div class="hint">备份文件写到这里；换目录不会自动搬旧数据</div></div>
      <button id="pickvault" class="ghost">选择…</button>
    </div>
    <div class="row">
      <label></label>
      <div class="grow" style="display:flex;gap:10px">
        <button id="save">保存</button>
        <button id="run" class="ghost">立即备份一次</button>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="status" style="margin-bottom:8px"><span>最近一次结果</span></div>
    <pre id="out">还没有跑过。</pre>
    <div class="note">备份走 memvault 的增量逻辑：会话没变化就跳过。日志：<span id="logpath">~/.dsh/memory-ark/run.log</span></div>
  </div>
</main>
<div id="toast" class="toast"></div>
<script>
var $ = function (id) { return document.getElementById(id) }
var cfg = null
function toast(t) { var el = $('toast'); el.textContent = t; el.className = 'toast show'; setTimeout(function () { el.className = 'toast' }, 2200) }
function api(path, opts) {
  return fetch('/dsh-memory-ark/' + path, opts).then(function (r) {
    return r.json().then(function (j) {
      if (!r.ok) throw new Error(j && j.error ? j.error : 'HTTP ' + r.status)
      return j
    })
  })
}
function fmt(t) { return t ? new Date(t).toLocaleString() : '—' }
function setStatus(s) {
  cfg = s.config
  $('dot').className = 'dot ' + (s.config.enabled ? 'on' : 'off')
  $('state').textContent = s.config.enabled ? '已开启' : '未开启'
  $('next').textContent = s.config.enabled ? fmt(s.nextDue) : '—'
  var last = s.state && s.state.lastResult
  $('last').textContent = last ? (last.ok ? '成功' : '失败') + ' · ' + fmt(last.at) : '—'
  if (last) $('out').textContent = last.output || (last.ok ? '成功（无输出）' : '失败（无输出）')
  if (s.config.memvaultPath && !$('mv').value) $('mv').value = s.config.memvaultPath
  if (s.config.vaultPath && !$('vault').value) $('vault').value = s.config.vaultPath
}
function fillWorkspaces(list, current) {
  var ws = $('ws'); ws.innerHTML = ''
  list.forEach(function (w) {
    var o = document.createElement('option')
    o.value = w.id
    o.textContent = w.title + '  （' + w.sessionCount + ' 个会话）'
    ws.appendChild(o)
  })
  if (current) ws.value = current
}
function loadSessions(current) {
  var ws = $('ws').value
  var sess = $('sess'); sess.innerHTML = ''
  if (!ws) return Promise.resolve()
  return api('sessions?workspaceId=' + encodeURIComponent(ws)).then(function (r) {
    r.sessions.forEach(function (s) {
      var o = document.createElement('option')
      o.value = s.id
      o.textContent = s.title + ' · ' + s.messages + ' 条 · ' + s.id.slice(0, 22) + '…'
      sess.appendChild(o)
    })
    if (current) sess.value = current
  }).catch(function (e) {
    var o = document.createElement('option'); o.textContent = '列会话失败：' + e.message; sess.appendChild(o)
  })
}
function load() {
  return Promise.all([api('status'), api('workspaces')]).then(function (res) {
    var s = res[0], w = res[1]
    setStatus(s)
    fillWorkspaces(w.workspaces, s.config.workspaceId)
    $('at').value = s.config.at || '23:30'
    $('enabled').checked = !!s.config.enabled
    return loadSessions(s.config.sessionId)
  }).catch(function (e) { toast(e.message) })
}
$('ws').onchange = function () { loadSessions() }
$('save').onclick = function () {
  $('save').disabled = true
  var body = {
    enabled: $('enabled').checked,
    workspaceId: $('ws').value,
    sessionId: $('sess').value,
    at: $('at').value || '23:30',
    memvaultPath: $('mv').value.trim(),
    vaultPath: $('vault').value.trim()
  }
  api('save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { setStatus(r); toast('已保存') })
    .catch(function (e) { toast('保存失败：' + e.message) })
    .finally(function () { $('save').disabled = false })
}
$('run').onclick = function () {
  $('run').disabled = true
  $('out').textContent = '正在备份…'
  api('run', { method: 'POST' }).then(function (r) {
    setStatus(r.status)
    toast(r.result && r.result.ok ? '备份完成' : '备份失败，看下面的输出')
  }).catch(function (e) { toast('备份失败：' + e.message) })
    .finally(function () { $('run').disabled = false })
}
$('pickvault').onclick = function () {
  $('pickvault').disabled = true
  toast('在弹出的窗口里选择记忆库目录…')
  api('pick-folder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then(function (r) {
      if (r.path) { $('vault').value = r.path; toast('已选择，记得点保存') }
      else if (r.cancelled) toast('已取消')
      else toast(r.error || '没有选到目录')
    })
    .catch(function (e) { toast('选择失败：' + e.message) })
    .finally(function () { $('pickvault').disabled = false })
}
load()
setInterval(function () { api('status').then(setStatus).catch(function () {}) }, 15000)
</script>
</body>
</html>`
