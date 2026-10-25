// 记忆方舟 · 客户端半边（设置 → 记忆方舟）
window.__ModuleLoader__.load({
  id: 'dsh-memory-ark',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const inject = ['slots']
    const B = '/dsh-memory-ark'

    const get = (p) =>
      fetch(B + p, { cache: 'no-store' }).then((r) =>
        r.json().then((j) => {
          if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status)
          return j
        }),
      )

    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then((r) =>
        r.json().then((j) => {
          if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status)
          return j
        }),
      )

    const fmt = (t) => {
      if (!t) return '—'
      try {
        return new Date(t).toLocaleString()
      } catch {
        return '—'
      }
    }

    const CSS = `
.ma-panel{display:flex;flex-direction:column;gap:13px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary)}
.ma-title{font-size:14px;font-weight:600;letter-spacing:.01em}
.ma-sub{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.ma-status{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ma-status b{color:var(--dsw-alias-label-primary);font-weight:600}
.ma-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.ma-label{min-width:64px;flex:none;color:var(--dsw-alias-label-secondary)}
.ma-input{flex:1;min-width:220px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;font:inherit;outline:none}
.ma-input:focus{border-color:var(--dsw-alias-brand-primary)}
.ma-check{display:flex;gap:7px;align-items:center;color:var(--dsw-alias-label-primary);cursor:pointer}
.ma-check input{accent-color:var(--dsw-alias-brand-primary)}
.ma-btn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 13px;font:inherit;cursor:pointer}
.ma-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.ma-btn:disabled{opacity:.5;cursor:default}
.ma-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:#fff}
.ma-pre{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 11px;font:12px/1.5 Consolas,monospace;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto;margin:0;color:var(--dsw-alias-label-secondary)}
.ma-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.ma-msg{font-size:12px;padding:6px 10px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.ma-adv{margin-top:2px}
.ma-adv summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}
.ma-adv .ma-row{margin-top:8px}
`

    function SettingsPanel() {
      const [workspaces, setWorkspaces] = React.useState([])
      const [sessions, setSessions] = React.useState([])
      const [wsId, setWsId] = React.useState('')
      const [sessId, setSessId] = React.useState('')
      const [at, setAt] = React.useState('23:30')
      const [enabled, setEnabled] = React.useState(false)
      const [mv, setMv] = React.useState('')
      const [vault, setVault] = React.useState('')
      const [nextDue, setNextDue] = React.useState(null)
      const [state, setState] = React.useState(null)
      const [out, setOut] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [loading, setLoading] = React.useState(true)

      const applyStatus = (s) => {
        if (!s) return
        if (s.config) {
          setEnabled(!!s.config.enabled)
          setAt(s.config.at || '23:30')
          setMv(s.config.memvaultPath || '')
          setVault(s.config.vaultPath || '')
        }
        if (s.state) setState(s.state)
        if (s.nextDue !== undefined) setNextDue(s.nextDue)
      }

      const loadSessions = async (wid, keep) => {
        if (!wid) {
          setSessions([])
          return []
        }
        const r = await get('/sessions?workspaceId=' + encodeURIComponent(wid))
        const list = r.sessions || []
        setSessions(list)
        const pick = keep && list.some((x) => x.id === keep) ? keep : list[0] && list[0].id
        setSessId(pick || '')
        return list
      }

      React.useEffect(() => {
        ;(async () => {
          try {
            const [st, ws] = await Promise.all([get('/status'), get('/workspaces')])
            setWorkspaces(ws.workspaces || [])
            applyStatus(st)
            if (st.state && st.state.lastResult) setOut(st.state.lastResult.output || '')
            const wid = st.config.workspaceId || (ws.workspaces[0] && ws.workspaces[0].id) || ''
            setWsId(wid)
            if (wid) await loadSessions(wid, st.config.sessionId)
            else setLoading(false)
          } catch (e) {
            setMsg('加载失败：' + (e && e.message ? e.message : e))
          } finally {
            setLoading(false)
          }
        })()
      }, [])

      const onWs = async (id) => {
        setWsId(id)
        setSessId('')
        setSessions([])
        try {
          await loadSessions(id)
        } catch (e) {
          setMsg('列会话失败：' + (e && e.message ? e.message : e))
        }
      }

      const save = async () => {
        setBusy(true)
        setMsg('')
        try {
          const r = await post('/save', {
            enabled,
            workspaceId: wsId,
            sessionId: sessId,
            at: at || '23:30',
            memvaultPath: mv,
            vaultPath: vault,
          })
          applyStatus(r)
          setMsg('已保存' + (enabled ? '，到点会自动备份' : '（开关是关的）'))
        } catch (e) {
          setMsg('保存失败：' + (e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }

      const runNow = async () => {
        setBusy(true)
        setMsg('正在备份…')
        try {
          const r = await post('/run', {})
          setOut((r.result && r.result.output) || '')
          if (r.status) applyStatus(r.status)
          setMsg(r.result && r.result.ok ? '备份完成' : '备份失败，看下面的输出')
        } catch (e) {
          setMsg('备份失败：' + (e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }

      const pickFolder = async () => {
        setBusy(true)
        setMsg('在弹出的窗口里选择记忆库目录…')
        try {
          const r = await post('/pick-folder', {})
          if (r.cancelled) setMsg('已取消选择')
          else if (r.path) {
            setVault(r.path)
            setMsg('已选择，记得点「保存」')
          } else setMsg('没有选到目录')
        } catch (e) {
          setMsg('选择失败：' + (e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }

      const last = state && state.lastResult

      return h(
        'div',
        { className: 'ma-panel' },
        h('div', { className: 'ma-title' }, '🐋 记忆方舟 · 每天自动备份'),
        h(
          'div',
          { className: 'ma-sub' },
          '选一个工作区里的一个会话，每天到点只备份这一条。DSH 关着时不会跑，下次打开会补跑最近错过的一次。',
        ),
        h(
          'div',
          { className: 'ma-status' },
          h('span', null, h('b', null, enabled ? '已开启' : '未开启')),
          h('span', null, '下次：', h('b', null, enabled ? fmt(nextDue) : '—')),
          h('span', null, '上次：', h('b', null, last ? (last.ok ? '成功' : '失败') + ' · ' + fmt(last.at) : '—')),
        ),
        h(
          'div',
          { className: 'ma-row' },
          h('span', { className: 'ma-label' }, '工作区'),
          h(
            'select',
            { className: 'ma-input', value: wsId, onChange: (e) => onWs(e.target.value), disabled: loading || busy },
            workspaces.map((w) =>
              h('option', { key: w.id, value: w.id }, w.title + '（' + w.sessionCount + ' 个会话）'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'ma-row' },
          h('span', { className: 'ma-label' }, '会话'),
          h(
            'select',
            { className: 'ma-input', value: sessId, onChange: (e) => setSessId(e.target.value), disabled: loading || busy },
            sessions.length
              ? sessions.map((s) =>
                  h(
                    'option',
                    { key: s.id, value: s.id },
                    s.title + ' · ' + s.messages + ' 条 · ' + s.id.slice(0, 18) + '…',
                  ),
                )
              : h('option', { value: '' }, '（这个工作区还没有会话）'),
          ),
        ),
        h(
          'div',
          { className: 'ma-row' },
          h('span', { className: 'ma-label' }, '每天几点'),
          h('input', { className: 'ma-input', type: 'time', value: at, onChange: (e) => setAt(e.target.value), disabled: busy }),
        ),
        h(
          'div',
          { className: 'ma-row' },
          h('span', { className: 'ma-label' }, '开关'),
          h(
            'label',
            { className: 'ma-check' },
            h('input', { type: 'checkbox', checked: enabled, onChange: (e) => setEnabled(e.target.checked), disabled: busy }),
            '每天自动备份一次',
          ),
        ),
        h(
          'details',
          { className: 'ma-adv' },
          h('summary', null, '高级：记忆库目录'),
          h(
            'div',
            { className: 'ma-row' },
            h('span', { className: 'ma-label' }, '记忆库目录'),
            h('input', {
              className: 'ma-input',
              value: vault,
              placeholder: '留空 = memvault.mjs 旁边的 vault',
              onChange: (e) => setVault(e.target.value),
              disabled: busy,
            }),
            h('button', { className: 'ma-btn', onClick: pickFolder, disabled: busy }, '选择…'),
          ),
          h('div', { className: 'ma-note' }, '留空 = memvault.mjs 旁边的 vault；换目录不会自动搬旧数据。'),
        ),
        h(
          'div',
          { className: 'ma-row' },
          h('button', { className: 'ma-btn ma-primary', onClick: save, disabled: busy }, '保存'),
          h('button', { className: 'ma-btn', onClick: runNow, disabled: busy || !sessId }, '立即备份一次'),
        ),
        msg ? h('div', { className: 'ma-msg' }, msg) : null,
        h('pre', { className: 'ma-pre' }, out || '还没有跑过。'),
        h(
          'div',
          { className: 'ma-note' },
          '只备份选中的那一个会话；没变化会自动跳过。日志：~/.dsh/memory-ark/run.log',
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      const styles = ctx.get('styles')
      if (styles && typeof styles.insert === 'function') styles.insert(CSS)
      else if (typeof document !== 'undefined') {
        const el = document.createElement('style')
        el.textContent = CSS
        document.head.appendChild(el)
      }
      if (!slots) {
        console.error('[dsh-memory-ark] 拿不到 slots 服务')
        return
      }
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'memory-ark', order: 118, label: '记忆方舟' },
          () => h(SettingsPanel),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
