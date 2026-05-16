import './style.css'
import {
  ReminderType,
  computeDerived,
  buildReminderCandidates,
  isAlreadySent,
  markSent,
  makeId,
  nowIso,
  statusLabel,
  todayIsoLocal,
  formatMoney,
} from './domain.js'
import {
  clearState,
  exportStateToJson,
  importStateFromJsonText,
  loadState,
  saveState,
} from './store.js'
import { parseOcrResultToInvoiceDrafts, recognizeImageToResult } from './ocr.js'

const appEl = document.querySelector('#app')

let state = loadState()
let ui = {
  view: 'ledger',
  editingId: null,
  notice: '',
  ocr: {
    file: null,
    running: false,
    status: '',
    progress: 0,
    rawText: '',
    drafts: [],
    confidences: [],
    draftIndex: 0,
    error: '',
  },
  reminders: {
    generatedAt: '',
    candidates: [],
  },
  backup: {
    importText: '',
    importError: '',
  },
}

render()

document.addEventListener('click', async (e) => {
  const target = e.target
  if (!(target instanceof HTMLElement)) return

  const actionEl = target.closest('[data-action]')
  if (!(actionEl instanceof HTMLElement)) return

  const action = actionEl.dataset.action
  if (!action) return

  try {
    await handleAction(action, actionEl)
  } catch (err) {
    ui.notice = `操作失败：${err?.message ?? String(err)}`
    render()
  }
})

document.addEventListener('change', async (e) => {
  const target = e.target
  if (!(target instanceof HTMLInputElement)) return

  if (target.id === 'ocr-file') {
    ui.ocr.file = target.files?.[0] ?? null
    ui.ocr.error = ''
    syncOcrSelectedFileUi()
  }

  if (target.id === 'backup-import') {
    const file = target.files?.[0]
    ui.backup.importError = ''
    ui.backup.importText = ''
    if (!file) {
      render()
      return
    }
    ui.backup.importText = await file.text()
    render()
  }

  if (target.name === 'dueDate') {
    const normalized = normalizeIsoDateInput(target.value)
    if (normalized && normalized !== target.value) {
      target.value = normalized
    }
  }
})

document.addEventListener('submit', (e) => {
  const form = e.target
  if (!(form instanceof HTMLFormElement)) return
  if (form.id === 'invoice-form') {
    e.preventDefault()
    handleInvoiceSubmit(form)
  }
  if (form.id === 'ocr-draft-form') {
    e.preventDefault()
    handleOcrDraftSubmit(form)
  }
})

async function handleAction(action, el) {
  if (action === 'switch-view') {
    ui.view = el.dataset.view
    ui.notice = ''
    render()
    return
  }

  if (action === 'new-invoice') {
    ui.editingId = null
    ui.notice = ''
    render()
    return
  }

  if (action === 'edit-invoice') {
    ui.editingId = el.dataset.id
    ui.notice = ''
    render()
    return
  }

  if (action === 'delete-invoice') {
    const id = el.dataset.id
    state = { ...state, invoices: state.invoices.filter((x) => x.id !== id) }
    saveState(state)
    if (ui.editingId === id) ui.editingId = null
    ui.notice = '已删除账款记录。'
    render()
    return
  }

  if (action === 'run-ocr') {
    await runOcr()
    return
  }

  if (action === 'ocr-prev-draft') {
    const total = ui.ocr.drafts?.length || 0
    if (total > 0) {
      ui.ocr.draftIndex = Math.max(0, (ui.ocr.draftIndex || 0) - 1)
      ui.notice = ''
      render()
    }
    return
  }

  if (action === 'ocr-next-draft') {
    const total = ui.ocr.drafts?.length || 0
    if (total > 0) {
      ui.ocr.draftIndex = Math.min(total - 1, (ui.ocr.draftIndex || 0) + 1)
      ui.notice = ''
      render()
    }
    return
  }

  if (action === 'generate-reminders') {
    const today = todayIsoLocal()
    ui.reminders.candidates = buildReminderCandidates(state.invoices, state.settings, today)
    ui.reminders.generatedAt = nowIso()
    ui.notice = `已生成提醒（${ui.reminders.candidates.length} 条）。`
    render()
    return
  }

  if (action === 'send-reminder') {
    const invoiceId = el.dataset.invoiceId
    const type = el.dataset.type
    const windowKey = el.dataset.windowKey
    await sendReminder({ invoiceId, type, windowKey })
    return
  }

  if (action === 'send-all-reminders') {
    await sendAllReminders()
    return
  }

  if (action === 'export-backup') {
    downloadTextFile(exportStateToJson(state), `ar-backup-${todayIsoLocal()}.json`, 'application/json')
    ui.notice = '已导出备份文件。'
    render()
    return
  }

  if (action === 'export-report-word') {
    const html = buildHumanReadableReportHtml(state)
    downloadTextFile(html, `ar-report-${todayIsoLocal()}.doc`, 'application/msword')
    ui.notice = '已导出 Word 报告（可直接打开查看）。'
    render()
    return
  }

  if (action === 'export-report-pdf') {
    printHumanReadableReportPdf(state)
    ui.notice = '已打开系统打印：请选择“另存为 PDF”。'
    render()
    return
  }

  if (action === 'import-backup') {
    if (!ui.backup.importText) {
      ui.backup.importError = '请先选择备份文件（JSON）。'
      render()
      return
    }
    try {
      state = importStateFromJsonText(ui.backup.importText)
      saveState(state)
      ui.notice = '已恢复备份。'
      ui.backup.importError = ''
    } catch (err) {
      ui.backup.importError = `导入失败：${err?.message ?? String(err)}`
    }
    render()
    return
  }

  if (action === 'clear-all') {
    clearState()
    state = loadState()
    ui.editingId = null
    ui.reminders.candidates = []
    ui.notice = '已清空本地数据。'
    render()
    return
  }
}

function handleInvoiceSubmit(form) {
  const fd = new FormData(form)
  const payload = {
    customer: String(fd.get('customer') || '').trim(),
    project: String(fd.get('project') || '').trim(),
    receivableAmount: String(fd.get('receivableAmount') || '').trim(),
    receivedAmount: String(fd.get('receivedAmount') || '').trim(),
    dueDate: normalizeIsoDateInput(String(fd.get('dueDate') || '').trim()),
    owner: String(fd.get('owner') || '').trim(),
  }

  if (!payload.customer || !payload.project || !payload.owner) {
    ui.notice = '请填写：客户、项目、负责人。'
    render()
    return
  }

  if (!payload.dueDate) {
    ui.notice = '到期日格式不正确，请选择日期或填写 YYYY-MM-DD（例如：2026-05-10）。'
    render()
    return
  }

  const ts = nowIso()
  if (ui.editingId) {
    state = {
      ...state,
      invoices: state.invoices.map((x) =>
        x.id === ui.editingId ? { ...x, ...payload, updatedAt: ts } : x,
      ),
    }
    ui.notice = '已更新账款记录。'
    ui.editingId = null
  } else {
    state = {
      ...state,
      invoices: [
        ...state.invoices,
        {
          id: makeId('inv'),
          ...payload,
          createdAt: ts,
          updatedAt: ts,
        },
      ],
    }
    ui.notice = '已新增账款记录。'
  }

  saveState(state)
  render()
}

function handleOcrDraftSubmit(form) {
  const fd = new FormData(form)
  const payload = {
    customer: String(fd.get('customer') || '').trim(),
    project: String(fd.get('project') || '').trim(),
    receivableAmount: String(fd.get('receivableAmount') || '').trim(),
    receivedAmount: String(fd.get('receivedAmount') || '').trim(),
    dueDate: normalizeIsoDateInput(String(fd.get('dueDate') || '').trim()),
    owner: String(fd.get('owner') || '').trim(),
  }
  if (!payload.customer || !payload.project || !payload.owner) {
    ui.notice = 'OCR 导入前请补齐：客户、项目、负责人。'
    render()
    return
  }

  if (!payload.dueDate) {
    ui.notice = '到期日格式不正确，请选择日期或填写 YYYY-MM-DD（例如：2026-05-10）。'
    render()
    return
  }

  const ts = nowIso()
  state = {
    ...state,
    invoices: [
      ...state.invoices,
      {
        id: makeId('inv'),
        ...payload,
        createdAt: ts,
        updatedAt: ts,
      },
    ],
  }
  saveState(state)
  const total = ui.ocr.drafts?.length || 0
  if (total > 0) {
    const idx = Math.min(Math.max(0, ui.ocr.draftIndex || 0), total - 1)
    if (idx < total - 1) {
      ui.ocr.draftIndex = idx + 1
      ui.notice = `已入库第 ${idx + 1} 条（共 ${total} 条），请确认下一条。`
    } else {
      ui.notice = '已将 OCR 草稿导入为账款记录。'
      ui.ocr.drafts = []
      ui.ocr.confidences = []
      ui.ocr.draftIndex = 0
    }
  } else {
    ui.notice = '已将 OCR 草稿导入为账款记录。'
  }
  render()
}

async function runOcr() {
  if (!ui.ocr.file) {
    ui.ocr.error = '请先选择图片文件。'
    render()
    return
  }

  if (!String(ui.ocr.file.type || '').startsWith('image/')) {
    ui.ocr.error = '当前仅支持图片文件（建议：截图后上传 png/jpg/webp）。'
    render()
    return
  }
  ui.ocr.running = true
  ui.ocr.status = 'starting'
  ui.ocr.progress = 0
  ui.ocr.rawText = ''
  ui.ocr.drafts = []
  ui.ocr.confidences = []
  ui.ocr.draftIndex = 0
  ui.ocr.error = ''
  ui.notice = ''
  render()

  try {
    const ocrRes = await recognizeImageToResult(ui.ocr.file, {
      onProgress: ({ status, progress }) => {
        ui.ocr.status = status
        ui.ocr.progress = progress
        render()
      },
    })
    ui.ocr.rawText = ocrRes.text
    const parsed = parseOcrResultToInvoiceDrafts(ocrRes)
    ui.ocr.drafts = parsed.drafts || []
    ui.ocr.confidences = parsed.confidences || []
    ui.ocr.draftIndex = 0
    ui.ocr.status = 'done'
    const total = ui.ocr.drafts.length
    ui.notice = total
      ? `OCR 已完成（识别到 ${total} 条记录，请逐条确认后入库）。`
      : 'OCR 已完成（未识别到可用记录，请检查图片清晰度或裁剪表格区域）。'
  } catch (err) {
    ui.ocr.error = `OCR 失败：${err?.message ?? String(err)}`
  } finally {
    ui.ocr.running = false
    render()
  }
}

async function sendReminder({ invoiceId, type, windowKey }) {
  const invoice = state.invoices.find((x) => x.id === invoiceId)
  if (!invoice) return
  const derived = computeDerived(invoice, state.settings)
  const candidates = buildReminderCandidates([invoice], state.settings)
  const candidate = candidates.find((c) => c.type === type && c.windowKey === windowKey)
  const message = candidate?.message || '(提醒内容缺失)'

  const ts = nowIso()
  const already = isAlreadySent(state.sentKeys, invoiceId, type, windowKey)
  if (already) {
    state = {
      ...state,
      reminderLogs: [
        {
          id: makeId('log'),
          createdAt: ts,
          invoiceId,
          type,
          windowKey,
          channel: '模拟',
          result: 'skipped-duplicate',
          message,
        },
        ...state.reminderLogs,
      ],
    }
    saveState(state)
    ui.notice = '已跳过：重复提醒（去重生效）。'
    render()
    return
  }

  state = {
    ...state,
    sentKeys: markSent(state.sentKeys, invoiceId, type, windowKey, ts),
    reminderLogs: [
      {
        id: makeId('log'),
        createdAt: ts,
        invoiceId,
        type,
        windowKey,
        channel: '模拟',
        result: 'sent',
        message,
        snapshot: {
          customer: invoice.customer,
          project: invoice.project,
          owner: invoice.owner,
          dueDate: invoice.dueDate,
          outstanding: derived.outstanding,
        },
      },
      ...state.reminderLogs,
    ],
  }
  saveState(state)
  ui.notice = '已模拟发送提醒，并写入提醒日志。'
  render()
}

async function sendAllReminders() {
  if (!ui.reminders.candidates.length) {
    ui.notice = '请先生成提醒。'
    render()
    return
  }
  for (const c of ui.reminders.candidates) {
    await sendReminder({ invoiceId: c.invoice.id, type: c.type, windowKey: c.windowKey })
  }
}

function render() {
  const today = todayIsoLocal()
  const invoices = state.invoices.map((inv) => ({
    inv,
    derived: computeDerived(inv, state.settings, today),
  }))
  const overdue = invoices.filter((x) => x.derived.status === 'OVERDUE')

  appEl.innerHTML = `
  <div class="header">
    <div>
      <h1>应收账款逾期提醒 Demo</h1>
      <div class="subtle">今天：${today}；到期前提醒：提前 ${state.settings.dueSoonDays} 天。</div>
    </div>
    <div class="tabs" role="navigation" aria-label="views">
      ${tabButton('ledger', '台账')}
      ${tabButton('ocr', 'OCR导入')}
      ${tabButton('reminders', '提醒&日志')}
      ${tabButton('backup', '备份恢复')}
      ${tabButton('docs', '说明')}
    </div>
  </div>

  ${ui.notice ? `<div class="notice">${escapeHtml(ui.notice)}</div>` : ''}

  ${ui.view === 'ledger' ? renderLedgerView(invoices, overdue) : ''}
  ${ui.view === 'ocr' ? renderOcrView() : ''}
  ${ui.view === 'reminders' ? renderReminderView() : ''}
  ${ui.view === 'backup' ? renderBackupView() : ''}
  ${ui.view === 'docs' ? renderDocsView() : ''}
  `
}

function tabButton(view, label) {
  const current = ui.view === view
  return `<button class="tab" data-action="switch-view" data-view="${view}" aria-current="${current ? 'page' : 'false'}">${label}</button>`
}

function renderLedgerView(invoices, overdue) {
  const editing = ui.editingId ? state.invoices.find((x) => x.id === ui.editingId) : null
  const editingDerived = editing ? computeDerived(editing, state.settings) : null
  return `
  <div class="grid">
    <div class="card">
      <div class="actions" style="margin-bottom: 8px;">
        <button class="primary" data-action="new-invoice">新增账款</button>
      </div>

      <h2>台账列表（${invoices.length}）</h2>
      <table class="table">
        <thead>
          <tr>
            <th>客户</th>
            <th>项目</th>
            <th>应收</th>
            <th>已收</th>
            <th>未收</th>
            <th>到期日</th>
            <th>负责人</th>
            <th>状态</th>
            <th>逾期天数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${invoices
            .map(({ inv, derived }) => {
              const pill = statusPill(derived)
              return `
              <tr>
                <td>${escapeHtml(inv.customer)}</td>
                <td>${escapeHtml(inv.project)}</td>
                <td>${escapeHtml(formatMoney(derived.receivable))}</td>
                <td>${escapeHtml(formatMoney(derived.received))}</td>
                <td>${escapeHtml(formatMoney(derived.outstanding))}</td>
                <td>${escapeHtml(inv.dueDate)}</td>
                <td>${escapeHtml(inv.owner)}</td>
                <td>${pill}</td>
                <td>${derived.overdueDays || 0}</td>
                <td>
                  <div class="actions">
                    <button data-action="edit-invoice" data-id="${inv.id}">编辑</button>
                    <button class="danger" data-action="delete-invoice" data-id="${inv.id}">删除</button>
                  </div>
                </td>
              </tr>
              `
            })
            .join('')}
        </tbody>
      </table>

      <h2 style="margin-top: 14px;">逾期列表（${overdue.length}）</h2>
      <table class="table">
        <thead>
          <tr>
            <th>客户</th>
            <th>项目</th>
            <th>未收</th>
            <th>到期日</th>
            <th>负责人</th>
            <th>逾期天数</th>
          </tr>
        </thead>
        <tbody>
          ${overdue
            .map(({ inv, derived }) => {
              return `
              <tr>
                <td>${escapeHtml(inv.customer)}</td>
                <td>${escapeHtml(inv.project)}</td>
                <td>${escapeHtml(formatMoney(derived.outstanding))}</td>
                <td>${escapeHtml(inv.dueDate)}</td>
                <td>${escapeHtml(inv.owner)}</td>
                <td>${derived.overdueDays}</td>
              </tr>
              `
            })
            .join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>${editing ? '编辑账款' : '新增账款'}</h2>
      <form id="invoice-form">
        <label>客户</label>
        <input name="customer" placeholder="例如：ABC工程有限公司" value="${escapeAttr(editing?.customer || '')}" />

        <label>项目</label>
        <input name="project" placeholder="例如：沙特电站项目" value="${escapeAttr(editing?.project || '')}" />

        <label>应收金额</label>
        <input name="receivableAmount" inputmode="decimal" placeholder="例如：120000" value="${escapeAttr(editing?.receivableAmount || '')}" />

        <label>已收金额</label>
        <input name="receivedAmount" inputmode="decimal" placeholder="例如：20000" value="${escapeAttr(editing?.receivedAmount || '')}" />

        <label>到期日</label>
        <input name="dueDate" placeholder="YYYY-MM-DD" inputmode="numeric" value="${escapeAttr(normalizeIsoDateInput(editing?.dueDate || '') || '')}" />

        <label>负责人</label>
        <input name="owner" placeholder="例如：Lily" value="${escapeAttr(editing?.owner || '')}" />

        <div class="actions" style="margin-top: 10px;">
          <button type="submit" class="primary">保存</button>
        </div>
      </form>

      <div class="notice">
        <div class="subtle">自动计算（保存后在列表展示）：未收金额、状态、逾期天数</div>
        ${editingDerived ? renderDerivedKv(editingDerived) : ''}
      </div>
    </div>
  </div>
  `
}

function renderOcrView() {
  const p = Math.round((ui.ocr.progress || 0) * 100)
  const drafts = ui.ocr.drafts || []
  const total = drafts.length
  const idx = total ? Math.min(Math.max(0, ui.ocr.draftIndex || 0), total - 1) : 0
  const draft = total ? drafts[idx] : null
  const conf = (ui.ocr.confidences || [])[idx] || {}
  const file = ui.ocr.file
  const fileLine = file
    ? `已选择：${escapeHtml(file.name)}（${escapeHtml(formatBytes(file.size))}）`
    : '未选择文件'

  return `
  <div class="grid">
    <div class="card">
      <h2>OCR 导入（任意图片尽力识别）</h2>
      <div class="subtle">流程：上传图片 → OCR 抽取 → 生成字段草稿 → 人工确认后入库（不承诺一次性全自动准确）。</div>

      <label>选择图片（png/jpg/webp/截图等）</label>
      <input id="ocr-file" type="file" accept="image/*" />
      <div id="ocr-file-selected" class="subtle" style="margin-top: 6px;">${fileLine}</div>

      <div class="actions" style="margin-top: 10px;">
        <button class="primary" data-action="run-ocr" ${ui.ocr.running ? 'disabled' : ''}>开始识别</button>
      </div>

      ${ui.ocr.error ? `<div class="notice">${escapeHtml(ui.ocr.error)}</div>` : ''}

      <div class="notice">
        <div class="subtle">进度：${escapeHtml(ui.ocr.status || '-') }（${p}%）</div>
        <div class="progress" aria-label="ocr-progress"><div style="width:${p}%"></div></div>
      </div>

      <label>OCR 原始文本（可复制检查）</label>
      <textarea readonly>${escapeHtml(ui.ocr.rawText || '')}</textarea>
    </div>

    <div class="card">
      <h2>识别草稿（人工确认后入库）</h2>
      ${draft ? `
      ${total > 1 ? `
      <div class="notice" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div class="subtle">当前：第 ${idx + 1} 条 / 共 ${total} 条</div>
        <div class="actions" style="margin:0;">
          <button data-action="ocr-prev-draft" ${idx <= 0 ? 'disabled' : ''}>上一条</button>
          <button data-action="ocr-next-draft" ${idx >= total - 1 ? 'disabled' : ''}>下一条</button>
        </div>
      </div>
      ` : ''}
      <form id="ocr-draft-form">
        <label>客户 <span class="subtle">(${conf.customer || '-'})</span></label>
        <input name="customer" value="${escapeAttr(draft.customer || '')}" />

        <label>项目 <span class="subtle">(${conf.project || '-'})</span></label>
        <input name="project" value="${escapeAttr(draft.project || '')}" />

        <label>应收金额 <span class="subtle">(${conf.receivableAmount || '-'})</span></label>
        <input name="receivableAmount" inputmode="decimal" value="${escapeAttr(draft.receivableAmount || '')}" />

        <label>已收金额 <span class="subtle">(${conf.receivedAmount || '-'})</span></label>
        <input name="receivedAmount" inputmode="decimal" value="${escapeAttr(draft.receivedAmount || '')}" />

        <label>到期日 <span class="subtle">(${conf.dueDate || '-'})</span></label>
        <input name="dueDate" placeholder="YYYY-MM-DD" inputmode="numeric" value="${escapeAttr(normalizeIsoDateInput(draft.dueDate || '') || '')}" />

        <label>负责人 <span class="subtle">(${conf.owner || '-'})</span></label>
        <input name="owner" value="${escapeAttr(draft.owner || '')}" />

        <div class="actions" style="margin-top: 10px;">
          <button type="submit" class="primary">确认入库</button>
        </div>
      </form>
      ` : `<div class="subtle">完成 OCR 后会在这里生成草稿。</div>`}
    </div>
  </div>
  `
}

function renderReminderView() {
  const generated = ui.reminders.candidates
  return `
  <div class="grid">
    <div class="card">
      <h2>提醒内容（生成后可模拟发送）</h2>
      <div class="actions" style="margin-bottom: 8px;">
        <button class="primary" data-action="generate-reminders">生成提醒（今天）</button>
        <button data-action="send-all-reminders">模拟发送全部</button>
      </div>
      <div class="subtle">去重规则：同一账款 + 同一提醒类型 + 同一窗口(windowKey) 只发送一次（避免重复提醒）。</div>
      <table class="table" style="margin-top: 8px;">
        <thead>
          <tr>
            <th>类型</th>
            <th>客户/项目</th>
            <th>负责人</th>
            <th>到期日</th>
            <th>未收</th>
            <th>提醒内容</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${generated
            .map((c) => {
              const already = isAlreadySent(state.sentKeys, c.invoice.id, c.type, c.windowKey)
              const typeLabel = c.type === ReminderType.OVERDUE ? '逾期' : '将到期'
              return `
              <tr>
                <td>${typeLabel}</td>
                <td>${escapeHtml(c.invoice.customer)} / ${escapeHtml(c.invoice.project)}</td>
                <td>${escapeHtml(c.invoice.owner)}</td>
                <td>${escapeHtml(c.invoice.dueDate)}</td>
                <td>${escapeHtml(formatMoney(c.derived.outstanding))}</td>
                <td><pre style="white-space:pre-wrap;margin:0;">${escapeHtml(c.message)}</pre></td>
                <td>
                  <button data-action="send-reminder" data-invoice-id="${c.invoice.id}" data-type="${c.type}" data-window-key="${c.windowKey}">${already ? '已发送/去重' : '模拟发送'}</button>
                </td>
              </tr>
              `
            })
            .join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>提醒日志（${state.reminderLogs.length}）</h2>
      <div class="subtle">记录每次提醒的生成/发送结果，便于审计与复盘。</div>
      <table class="table" style="margin-top: 8px;">
        <thead>
          <tr>
            <th>时间</th>
            <th>类型</th>
            <th>结果</th>
            <th>客户/项目</th>
          </tr>
        </thead>
        <tbody>
          ${state.reminderLogs
            .slice(0, 50)
            .map((l) => {
              const inv = state.invoices.find((x) => x.id === l.invoiceId)
              const label = l.type === ReminderType.OVERDUE ? '逾期' : '将到期'
              const cp = inv ? `${inv.customer} / ${inv.project}` : l.invoiceId
              return `
              <tr>
                <td>${escapeHtml(l.createdAt)}</td>
                <td>${label}</td>
                <td>${escapeHtml(l.result)}</td>
                <td>${escapeHtml(cp)}</td>
              </tr>
              `
            })
            .join('')}
        </tbody>
      </table>
      <div class="subtle">仅展示最近 50 条。</div>
    </div>
  </div>
  `
}

function renderBackupView() {
  return `
  <div class="grid">
    <div class="card">
      <h2>备份与恢复</h2>
      <div class="subtle">说明：JSON 备份用于“恢复导入”。</div>
      <div class="actions" style="margin-top: 10px;">
        <button class="primary" data-action="export-report-word">导出报告（Word）</button>
        <button data-action="export-report-pdf">导出报告（PDF）</button>
        <button data-action="export-backup">导出备份（JSON，用于恢复）</button>
        <button class="danger" data-action="clear-all">清空本地数据</button>
      </div>

      <label style="margin-top: 12px;">导入备份（JSON）</label>
      <input id="backup-import" type="file" accept="application/json" />
      <div class="actions" style="margin-top: 10px;">
        <button class="primary" data-action="import-backup">恢复导入</button>
      </div>
      ${ui.backup.importError ? `<div class="notice">${escapeHtml(ui.backup.importError)}</div>` : ''}
    </div>

    <div class="card">
      <h2>当前数据概览</h2>
      <div class="kv">
        <div>台账条数</div><div>${state.invoices.length}</div>
        <div>提醒日志</div><div>${state.reminderLogs.length}</div>
        <div>去重Key数量</div><div>${Object.keys(state.sentKeys || {}).length}</div>
        <div>提醒阈值</div><div>提前 ${state.settings.dueSoonDays} 天</div>
      </div>
    </div>
  </div>
  `
}

function renderDocsView() {
  return `
  <div class="grid">
    <div class="card">
      <h2>必须说明（按需求点）</h2>
      <div class="notice">
        <div><strong>后续如何接入飞书/企微</strong></div>
        <div class="subtle">建议做一层“通知适配器”：把本 Demo 里的提醒内容(message)发送到飞书/企微机器人 Webhook（HTTP POST）。生产环境需补齐：签名校验、失败重试、限流、告警。</div>
      </div>
      <div class="notice">
        <div><strong>如何避免重复提醒</strong></div>
        <div class="subtle">使用 sentKeys 去重：同一账款(invoiceId) + 类型(type) + 窗口(windowKey) 只发送一次；窗口示例：将到期用 dueDate+阈值，逾期按 7 天一个 bucket（可按公司策略调整）。</div>
      </div>
      <div class="notice">
        <div><strong>如何记录提醒日志</strong></div>
        <div class="subtle">每次模拟发送都会写入 reminderLogs：时间、类型、窗口Key、结果(sent/skipped-duplicate)、消息快照。用于审计/复盘。</div>
      </div>
      <div class="notice">
        <div><strong>如何备份和恢复数据</strong></div>
        <div class="subtle">通过“导出备份(JSON)”下载本地数据；“导入备份”可恢复至同一结构。后续可替换为数据库备份或对象存储。</div>
      </div>
    </div>

    <div class="card">
      <h2>OCR 交付口径（避免随机性）</h2>
      <div class="subtle">任意图片尽力识别，输出结构化草稿；入库前必须人工确认。若要提升准确率，可要求使用固定模板截图（同列顺序/对齐）。</div>
    </div>
  </div>
  `
}

function statusPill(derived) {
  const label = statusLabel(derived.status)
  if (derived.status === 'OVERDUE') return `<span class="pill danger">${label}</span>`
  if (derived.status === 'DUE_SOON' || derived.status === 'DUE_TODAY') return `<span class="pill warn">${label}</span>`
  if (derived.status === 'SETTLED') return `<span class="pill ok">${label}</span>`
  return `<span class="pill">${label}</span>`
}

function renderDerivedKv(derived) {
  return `
  <div class="kv">
    <div>未收金额</div><div>${escapeHtml(formatMoney(derived.outstanding))}</div>
    <div>状态</div><div>${escapeHtml(statusLabel(derived.status))}</div>
    <div>逾期天数</div><div>${derived.overdueDays || 0}</div>
  </div>
  `
}

function downloadTextFile(text, filename, mime) {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll('\n', ' ')
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(2)} GB`
}

function syncOcrSelectedFileUi() {
  const el = document.getElementById('ocr-file-selected')
  if (!el) return
  const file = ui.ocr.file
  if (!file) {
    el.textContent = '未选择文件'
    return
  }
  el.textContent = `已选择：${file.name}（${formatBytes(file.size)}）`
}

function buildHumanReadableReportHtml(appState) {
  const model = buildHumanReadableReportModel(appState)
  const css = buildHumanReadableReportCss()
  const body = buildHumanReadableReportBodyHtml(model)
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>应收账款逾期提醒报告</title>
  <style>${css}</style>
</head>
<body>
  ${body}
</body>
</html>`
}

function buildHumanReadableReportModel(appState) {
  const today = todayIsoLocal()
  const dueSoonDays = appState?.settings?.dueSoonDays ?? 7
  const invoices = (appState?.invoices || []).map((inv) => {
    const derived = computeDerived(inv, appState.settings, today)
    return { inv, derived }
  })
  const overdue = invoices.filter((x) => x.derived.status === 'OVERDUE')
  const logs = (appState?.reminderLogs || []).slice(0, 50)
  return { today, dueSoonDays, invoices, overdue, logs, appState }
}

function buildHumanReadableReportCss() {
  return `
:root { color-scheme: light; }
body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif; padding: 28px; color:#111; }
h1 { margin: 0 0 6px; font-size: 20px; }
.meta { margin: 0 0 16px; color: #444; font-size: 12px; }
h2 { margin: 18px 0 8px; font-size: 14px; }
.kv { display: grid; grid-template-columns: 140px 1fr; gap: 6px 12px; font-size: 12px; margin: 8px 0 12px; }
.box { border: 1px solid #ddd; border-radius: 10px; padding: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { border: 1px solid #e5e5e5; padding: 8px 10px; vertical-align: top; }
th { background: #f5f7fb; text-align: left; }
.subtle { color:#555; font-size: 12px; }
@media print { body { padding: 0; } .box { border: none; padding: 0; } }

/* In-place print mode */
body.__print-mode #app { display: none !important; }
body.__print-mode #__print-root { display: block !important; }
#__print-root { display: none; }
  `.trim()
}

function buildHumanReadableReportBodyHtml(model) {
  const { today, dueSoonDays, invoices, overdue, logs, appState } = model

  const rows = invoices
    .map(({ inv, derived }) => {
      return `
      <tr>
        <td>${escapeHtml(inv.customer || '')}</td>
        <td>${escapeHtml(inv.project || '')}</td>
        <td style="text-align:right;">${escapeHtml(formatMoney(derived.receivable))}</td>
        <td style="text-align:right;">${escapeHtml(formatMoney(derived.received))}</td>
        <td style="text-align:right;">${escapeHtml(formatMoney(derived.outstanding))}</td>
        <td>${escapeHtml(inv.dueDate || '')}</td>
        <td>${escapeHtml(inv.owner || '')}</td>
        <td>${escapeHtml(statusLabel(derived.status))}</td>
        <td style="text-align:right;">${derived.overdueDays || 0}</td>
      </tr>
    `
    })
    .join('')

  const overdueRows = overdue
    .map(({ inv, derived }) => {
      return `
      <tr>
        <td>${escapeHtml(inv.customer || '')}</td>
        <td>${escapeHtml(inv.project || '')}</td>
        <td style="text-align:right;">${escapeHtml(formatMoney(derived.outstanding))}</td>
        <td>${escapeHtml(inv.dueDate || '')}</td>
        <td>${escapeHtml(inv.owner || '')}</td>
        <td style="text-align:right;">${derived.overdueDays || 0}</td>
      </tr>
    `
    })
    .join('')

  const logRows = logs
    .map((l) => {
      const inv = (appState?.invoices || []).find((x) => x.id === l.invoiceId)
      const cp = inv ? `${inv.customer} / ${inv.project}` : l.invoiceId
      const label = l.type === ReminderType.OVERDUE ? '逾期' : '将到期'
      return `
      <tr>
        <td>${escapeHtml(l.createdAt || '')}</td>
        <td>${escapeHtml(label)}</td>
        <td>${escapeHtml(l.result || '')}</td>
        <td>${escapeHtml(cp)}</td>
      </tr>
    `
    })
    .join('')

  return `
  <h1>应收账款逾期提醒 Demo — 可视化报告</h1>
  <div class="meta">生成日期：${escapeHtml(today)}；到期前提醒阈值：提前 ${escapeHtml(String(dueSoonDays))} 天</div>

  <div class="box">
    <h2>概览</h2>
    <div class="kv">
      <div>台账条数</div><div>${invoices.length}</div>
      <div>逾期条数</div><div>${overdue.length}</div>
      <div>提醒日志（最近50条）</div><div>${logs.length}</div>
    </div>
    <div class="subtle">备注：本报告用于查看/汇报；如需恢复数据，请使用“导出备份（JSON）”。</div>
  </div>

  <h2>台账明细</h2>
  <div class="box">
    <table>
      <thead>
        <tr>
          <th>客户</th>
          <th>项目</th>
          <th>应收</th>
          <th>已收</th>
          <th>未收</th>
          <th>到期日</th>
          <th>负责人</th>
          <th>状态</th>
          <th>逾期天数</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="9" class="subtle">暂无数据</td></tr>'}
      </tbody>
    </table>
  </div>

  <h2>逾期清单</h2>
  <div class="box">
    <table>
      <thead>
        <tr>
          <th>客户</th>
          <th>项目</th>
          <th>未收</th>
          <th>到期日</th>
          <th>负责人</th>
          <th>逾期天数</th>
        </tr>
      </thead>
      <tbody>
        ${overdueRows || '<tr><td colspan="6" class="subtle">暂无逾期</td></tr>'}
      </tbody>
    </table>
  </div>

  <h2>提醒日志（最近50条）</h2>
  <div class="box">
    <table>
      <thead>
        <tr>
          <th>时间</th>
          <th>类型</th>
          <th>结果</th>
          <th>客户/项目</th>
        </tr>
      </thead>
      <tbody>
        ${logRows || '<tr><td colspan="4" class="subtle">暂无日志</td></tr>'}
      </tbody>
    </table>
  </div>
  `.trim()
}

function printHumanReadableReportPdf(appState) {
  // Build print DOM in-place (no popup), then call window.print().
  const cssId = '__print-style'
  const rootId = '__print-root'
  document.getElementById(cssId)?.remove()
  document.getElementById(rootId)?.remove()

  const style = document.createElement('style')
  style.id = cssId
  style.textContent = buildHumanReadableReportCss()
  document.head.appendChild(style)

  const model = buildHumanReadableReportModel(appState)
  const root = document.createElement('div')
  root.id = rootId
  root.innerHTML = buildHumanReadableReportBodyHtml(model)
  document.body.appendChild(root)

  const cleanup = () => {
    document.body.classList.remove('__print-mode')
    window.removeEventListener('afterprint', cleanup)
    document.getElementById(cssId)?.remove()
    document.getElementById(rootId)?.remove()
    render()
  }

  window.addEventListener('afterprint', cleanup)
  document.body.classList.add('__print-mode')
  try {
    const startedAt = Date.now()
    window.print()

    // In most browsers, window.print() blocks until the dialog closes.
    // If it did block, we can safely cleanup immediately after it returns.
    const elapsed = Date.now() - startedAt
    if (elapsed > 250) cleanup()
  } catch {
    cleanup()
    throw new Error('无法打开系统打印，请检查浏览器权限或更换浏览器重试。')
  }
}

function normalizeIsoDateInput(value) {
  const s = String(value ?? '').trim()
  if (!s) return ''

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (!m) m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s)
  if (!m) m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (!m) m = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/.exec(s)
  if (!m) return ''

  const yyyy = String(m[1])
  const mm = String(Number(m[2])).padStart(2, '0')
  const dd = String(Number(m[3])).padStart(2, '0')
  const iso = `${yyyy}-${mm}-${dd}`
  return isValidIsoDate(iso) ? iso : ''
}

function isValidIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim())
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return false
  const dt = new Date(y, mo - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d
}
