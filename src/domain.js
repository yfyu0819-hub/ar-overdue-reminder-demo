export const ReminderType = {
  DUE_SOON: 'DUE_SOON',
  OVERDUE: 'OVERDUE',
}

export const InvoiceStatus = {
  SETTLED: 'SETTLED',
  NOT_DUE: 'NOT_DUE',
  DUE_SOON: 'DUE_SOON',
  DUE_TODAY: 'DUE_TODAY',
  OVERDUE: 'OVERDUE',
}

export function nowIso() {
  return new Date().toISOString()
}

export function todayIsoLocal() {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function parseIsoDateLocal(iso) {
  if (!iso) return null
  const m = /^\d{4}-\d{2}-\d{2}$/.exec(String(iso).trim())
  if (!m) return null
  const [y, mo, da] = iso.split('-').map((v) => Number(v))
  const d = new Date(y, mo - 1, da)
  if (Number.isNaN(d.getTime())) return null
  return d
}

export function diffDaysLocal(a, b) {
  // a - b in days (local calendar days)
  const start = new Date(a.getFullYear(), a.getMonth(), a.getDate())
  const end = new Date(b.getFullYear(), b.getMonth(), b.getDate())
  const ms = start.getTime() - end.getTime()
  return Math.round(ms / 86400000)
}

export function toMoneyNumber(value) {
  if (value === null || value === undefined) return 0
  const n = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : 0
}

export function formatMoney(value) {
  const n = toMoneyNumber(value)
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

export function computeDerived(invoice, settings, todayIso = todayIsoLocal()) {
  const receivable = toMoneyNumber(invoice.receivableAmount)
  const received = toMoneyNumber(invoice.receivedAmount)
  const outstanding = Math.max(0, receivable - received)

  const today = parseIsoDateLocal(todayIso)
  const due = parseIsoDateLocal(invoice.dueDate)

  let overdueDays = 0
  let daysUntilDue = null
  if (today && due) {
    const delta = diffDaysLocal(due, today) // due - today
    daysUntilDue = delta
    if (outstanding > 0) {
      overdueDays = Math.max(0, -delta)
    }
  }

  const status = getInvoiceStatus({ outstanding, daysUntilDue })

  return {
    receivable,
    received,
    outstanding,
    status,
    overdueDays,
    daysUntilDue,
    dueSoonDays: settings?.dueSoonDays ?? 7,
  }
}

export function getInvoiceStatus({ outstanding, daysUntilDue }) {
  if (outstanding <= 0) return InvoiceStatus.SETTLED
  if (daysUntilDue === null) return InvoiceStatus.NOT_DUE
  if (daysUntilDue < 0) return InvoiceStatus.OVERDUE
  if (daysUntilDue === 0) return InvoiceStatus.DUE_TODAY
  if (daysUntilDue <= 7) return InvoiceStatus.DUE_SOON
  return InvoiceStatus.NOT_DUE
}

export function statusLabel(status) {
  switch (status) {
    case InvoiceStatus.SETTLED:
      return '已结清'
    case InvoiceStatus.OVERDUE:
      return '已逾期'
    case InvoiceStatus.DUE_TODAY:
      return '今日到期'
    case InvoiceStatus.DUE_SOON:
      return '即将到期'
    case InvoiceStatus.NOT_DUE:
    default:
      return '未到期'
  }
}

export function buildReminderCandidates(invoices, settings, todayIso = todayIsoLocal()) {
  const list = []
  const dueSoonDays = Number(settings?.dueSoonDays) || 7

  for (const invoice of invoices) {
    const derived = computeDerived(invoice, settings, todayIso)
    if (derived.outstanding <= 0) continue

    if (derived.status === InvoiceStatus.DUE_SOON || derived.status === InvoiceStatus.DUE_TODAY) {
      const windowKey = `due-${invoice.dueDate}-soon-${dueSoonDays}`
      list.push({
        invoice,
        derived,
        type: ReminderType.DUE_SOON,
        windowKey,
        message: buildReminderMessage(invoice, derived, ReminderType.DUE_SOON, dueSoonDays),
      })
    }

    if (derived.status === InvoiceStatus.OVERDUE) {
      const weekBucket = Math.floor(derived.overdueDays / 7)
      const windowKey = `due-${invoice.dueDate}-overdue-week-${weekBucket}`
      list.push({
        invoice,
        derived,
        type: ReminderType.OVERDUE,
        windowKey,
        message: buildReminderMessage(invoice, derived, ReminderType.OVERDUE, dueSoonDays),
      })
    }
  }

  // Stable ordering: overdue first, then due soon; larger overdueDays first
  return list.sort((a, b) => {
    const priA = a.type === ReminderType.OVERDUE ? 0 : 1
    const priB = b.type === ReminderType.OVERDUE ? 0 : 1
    if (priA !== priB) return priA - priB
    return (b.derived.overdueDays || 0) - (a.derived.overdueDays || 0)
  })
}

export function makeSentKey(invoiceId, type, windowKey) {
  return `${invoiceId}|${type}|${windowKey}`
}

export function isAlreadySent(sentKeys, invoiceId, type, windowKey) {
  const key = makeSentKey(invoiceId, type, windowKey)
  return Boolean(sentKeys?.[key])
}

export function markSent(sentKeys, invoiceId, type, windowKey, isoTime) {
  const key = makeSentKey(invoiceId, type, windowKey)
  return {
    ...sentKeys,
    [key]: isoTime,
  }
}

export function buildReminderMessage(invoice, derived, type, dueSoonDays) {
  const base = `客户：${invoice.customer || '-'}；项目：${invoice.project || '-'}；负责人：${invoice.owner || '-'}；到期日：${invoice.dueDate || '-'}；未收：${formatMoney(derived.outstanding)}`

  if (type === ReminderType.DUE_SOON) {
    const days = derived.daysUntilDue ?? ''
    return `【应收将到期提醒】距离到期 ${days} 天（阈值：提前 ${dueSoonDays} 天）\n${base}`
  }

  return `【应收逾期提醒】已逾期 ${derived.overdueDays} 天\n${base}`
}

export function makeId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
