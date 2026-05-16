import Tesseract from 'tesseract.js'

export async function recognizeImageToText(fileOrBlob, { onProgress } = {}) {
  const res = await recognizeImageToResult(fileOrBlob, { onProgress })
  return res.text
}

export async function recognizeImageToResult(fileOrBlob, { onProgress } = {}) {
  const { data } = await Tesseract.recognize(fileOrBlob, 'chi_sim+eng', {
    logger: (m) => {
      if (m?.status && typeof m?.progress === 'number') {
        onProgress?.({ status: m.status, progress: m.progress })
      }
    },
  })

  const text = String(data?.text ?? '')
  const words = Array.isArray(data?.words) ? data.words : []

  return {
    text,
    words: words
      .map((w) => ({
        text: String(w?.text ?? '').trim(),
        confidence: Number.isFinite(Number(w?.confidence)) ? Number(w.confidence) : null,
        bbox: normalizeBbox(w?.bbox),
      }))
      .filter((w) => w.text && w.bbox),
  }
}

function normalizeBbox(b) {
  if (!b) return null
  const x0 = Number(b.x0)
  const y0 = Number(b.y0)
  const x1 = Number(b.x1)
  const y1 = Number(b.y1)
  if (![x0, y0, x1, y1].every((n) => Number.isFinite(n))) return null
  const left = Math.min(x0, x1)
  const right = Math.max(x0, x1)
  const top = Math.min(y0, y1)
  const bottom = Math.max(y0, y1)
  if (right - left <= 0 || bottom - top <= 0) return null
  return { left, right, top, bottom }
}

export function parseOcrResultToInvoiceDrafts(ocrResult) {
  const rawText = String(ocrResult?.text ?? '')
  const text = normalizeText(rawText)

  const draftsFromLayout = parseTableFromLayout(ocrResult?.words)
  if (draftsFromLayout?.drafts?.length) {
    return {
      drafts: draftsFromLayout.drafts,
      confidences: draftsFromLayout.confidences,
      normalizedText: text,
    }
  }

  // Fallback: robust text-based multi-row parser
  return parseOcrTextToInvoiceDrafts(text)
}

export function parseOcrTextToInvoiceDrafts(rawText) {
  const text = normalizeText(rawText)
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  if (!lines.length) {
    return { drafts: [], confidences: [], normalizedText: text }
  }

  const table = detectTableHeader(lines)
  const drafts = []
  const confidences = []

  if (table) {
    for (let i = table.headerIndex + 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      if (looksLikeTableHeader(line)) continue

      const row = parseRowByHeader(line, table.columns)
      if (!row) continue

      const draft = row
      const confidence = {
        customer: draft.customer ? 'medium' : 'low',
        project: draft.project ? 'medium' : 'low',
        receivableAmount: draft.receivableAmount ? 'medium' : 'low',
        receivedAmount: draft.receivedAmount ? 'medium' : 'low',
        dueDate: draft.dueDate ? 'medium' : 'low',
        owner: draft.owner ? 'medium' : 'low',
      }

      // Sanity: must have at least customer + (amount or date)
      if (!draft.customer) continue
      if (!draft.dueDate && !draft.receivableAmount && !draft.receivedAmount) continue

      drafts.push(draft)
      confidences.push(confidence)
      if (drafts.length >= 50) break
    }

    return { drafts, confidences, normalizedText: text }
  }

  // No header detected: try fixed-order reconstruction per line.
  const fixedColumns = ['customer', 'project', 'receivableAmount', 'receivedAmount', 'dueDate', 'owner']
  for (const line of lines) {
    // must contain a date to be a data row
    const date = findAnyDate(line)
    if (!date) continue

    const tokens = tokenizeRow(line)
      .map((t) => t.replace(/[￥¥]/g, ''))
      .map((t) => t.replace(/元/g, ''))
      .filter(Boolean)
    if (!tokens.length) continue

    const cells = buildCellsFromTokens(tokens, fixedColumns)
    if (!cells) continue

    const draft = {
      customer: cleanupValue(cells[0] || ''),
      project: cleanupValue(cells[1] || ''),
      receivableAmount: normalizeMoneyToken(cells[2] || ''),
      receivedAmount: normalizeMoneyToken(cells[3] || ''),
      dueDate: findAnyDate(cells[4] || '') || date,
      owner: cleanupValue(cells[5] || ''),
    }

    if (!draft.customer) continue
    drafts.push(draft)
    confidences.push({
      customer: draft.customer ? 'medium' : 'low',
      project: draft.project ? 'low' : 'low',
      receivableAmount: draft.receivableAmount ? 'medium' : 'low',
      receivedAmount: draft.receivedAmount ? 'medium' : 'low',
      dueDate: draft.dueDate ? 'medium' : 'low',
      owner: draft.owner ? 'low' : 'low',
    })
    if (drafts.length >= 50) break
  }

  // If still nothing, fall back to single draft guess.
  if (!drafts.length) {
    const single = parseOcrTextToInvoiceDraft(text)
    return {
      drafts: single?.draft ? [single.draft] : [],
      confidences: single?.confidence ? [single.confidence] : [],
      normalizedText: text,
    }
  }

  return { drafts, confidences, normalizedText: text }
}

export function parseOcrTextToInvoiceDraft(rawText) {
  const text = normalizeText(rawText)
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const result = {
    customer: '',
    project: '',
    receivableAmount: '',
    receivedAmount: '',
    dueDate: '',
    owner: '',
  }

  const confidence = {
    customer: 'low',
    project: 'low',
    receivableAmount: 'low',
    receivedAmount: 'low',
    dueDate: 'low',
    owner: 'low',
  }

  // Label-based extraction (higher confidence)
  const customer = findLabelValue(lines, ['客户', 'customer', 'client'])
  if (customer) {
    result.customer = customer
    confidence.customer = 'high'
  }

  const project = findLabelValue(lines, ['项目', 'project'])
  if (project) {
    result.project = project
    confidence.project = 'high'
  }

  const owner = findLabelValue(lines, ['负责人', 'owner', '负责人/经办'])
  if (owner) {
    result.owner = owner
    confidence.owner = 'high'
  }

  const dueDate = findAnyDate(text)
  if (dueDate) {
    result.dueDate = dueDate
    confidence.dueDate = 'medium'
  }

  const receivable = findLabeledMoney(lines, ['应收金额', '应收', 'Amount Due', 'Receivable', '应收款'])
  if (receivable) {
    result.receivableAmount = receivable
    confidence.receivableAmount = 'high'
  }

  const received = findLabeledMoney(lines, ['已收金额', '已收', '回款', 'Paid', 'Received'])
  if (received) {
    result.receivedAmount = received
    confidence.receivedAmount = 'high'
  }

  // Table-like fallback: find a line that has a date + two amounts
  if (!result.customer || !result.project || !result.receivableAmount || !result.dueDate) {
    const candidate = guessFromRow(lines)
    if (candidate) {
      for (const k of Object.keys(result)) {
        if (!result[k] && candidate[k]) {
          result[k] = candidate[k]
        }
      }

      if (candidate.customer && confidence.customer === 'low') confidence.customer = 'medium'
      if (candidate.project && confidence.project === 'low') confidence.project = 'medium'
      if (candidate.owner && confidence.owner === 'low') confidence.owner = 'medium'
      if (candidate.dueDate && confidence.dueDate === 'low') confidence.dueDate = 'medium'
      if (candidate.receivableAmount && confidence.receivableAmount === 'low') confidence.receivableAmount = 'medium'
      if (candidate.receivedAmount && confidence.receivedAmount === 'low') confidence.receivedAmount = 'medium'
    }
  }

  // Last resort for amounts: pick two largest numbers
  if (!result.receivableAmount) {
    const nums = extractMoneyNumbers(text)
    if (nums.length) {
      result.receivableAmount = String(nums[0])
      confidence.receivableAmount = 'low'
      if (!result.receivedAmount && nums.length > 1) {
        result.receivedAmount = String(nums[1])
        confidence.receivedAmount = 'low'
      }
    }
  }

  return { draft: result, confidence, normalizedText: text }
}

function normalizeText(text) {
  const raw = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u3000\t]/g, ' ')

  return raw
    .split('\n')
    // Preserve 2+ spaces as potential column separators (tables), but
    // still normalize messy whitespace.
    .map((l) =>
      String(l)
        // Keep double spaces (column separators) and collapse 3+ to 2.
        .replace(/ {3,}/g, '  ')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function findLabelValue(lines, labels) {
  // Prefer explicit label delimiter to avoid treating table headers like
  // "客户、项目、应收金额..." as a label-value line.
  const labelReStrict = new RegExp(`^(${labels.map(escapeRe).join('|')})\\s*[:：]\\s*(.+)$`, 'i')
  for (const line of lines) {
    const m = labelReStrict.exec(line)
    if (m?.[2]) return cleanupValue(m[2])
  }

  // Loose form: "客户 ABC公司" (no colon). Only accept when it's clearly
  // not a header list.
  const labelReLoose = new RegExp(`^(${labels.map(escapeRe).join('|')})\\s+(.+)$`, 'i')
  for (const line of lines) {
    if (/[、,，]/.test(line)) continue
    const m = labelReLoose.exec(line)
    if (m?.[2]) {
      const v = cleanupValue(m[2])
      if (v && v.length <= 40) return v
    }
  }

  return ''
}

function cleanupValue(v) {
  return String(v)
    .replace(/^[、,，\-—\s]+/, '')
    .replace(/^[-—]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function findAnyDate(text) {
  // 2026-05-22 / 2026/05/22 / 2026.05.22
  // Prefer two-digit month/day when present; enforce boundary after day
  // so "2024.12.31" won't be matched as day=3.
  const m1 = /(20\d{2})\s*[-/.]\s*(1[0-2]|0?[1-9])\s*[-/.]\s*(3[01]|[12]\d|0?[1-9])(?!\d)/.exec(text)
  if (m1) return toIsoDate(m1[1], m1[2], m1[3])

  // 2026年5月22日
  const m2 = /(20\d{2})\s*年\s*(1[0-2]|0?[1-9])\s*月\s*(3[01]|[12]\d|0?[1-9])\s*日(?!\d)/.exec(text)
  if (m2) return toIsoDate(m2[1], m2[2], m2[3])

  return ''
}

function toIsoDate(y, m, d) {
  const yyyy = String(y).padStart(4, '0')
  const mm = String(m).padStart(2, '0')
  const dd = String(d).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function findLabeledMoney(lines, labels) {
  const labelRe = new RegExp(`^(${labels.map(escapeRe).join('|')}).*?(\d[\d,]*\.?\d{0,2})`, 'i')
  for (const line of lines) {
    const m = labelRe.exec(line)
    if (m?.[2]) return stripMoney(m[2])
  }
  return ''
}

function stripMoney(v) {
  return String(v).replace(/,/g, '').trim()
}

function extractMoneyNumbers(text) {
  const matches = [...String(text).matchAll(/\b\d[\d,]*\.?\d{0,2}\b/g)]
  const nums = matches
    .map((m) => Number(String(m[0]).replace(/,/g, '')))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a)

  // De-dup close numbers
  const dedup = []
  for (const n of nums) {
    if (!dedup.some((x) => Math.abs(x - n) < 0.01)) dedup.push(n)
  }
  return dedup
}

function guessFromRow(lines) {
  // Prefer header-driven table parsing so column order can vary.
  const table = detectTableHeader(lines)
  if (table) {
    for (let i = table.headerIndex + 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      if (looksLikeTableHeader(line)) continue

      const row = parseRowByHeader(line, table.columns)
      if (!row) continue

      // Minimum sanity: need at least customer + (amount or dueDate)
      if (!row.customer) continue
      if (!row.dueDate && !row.receivableAmount && !row.receivedAmount) continue
      return row
    }
  }

  // Fallback heuristic (fixed order) when no header was detected.
  for (const line of lines) {
    const date = findAnyDate(line)
    if (!date) continue

    const tokens = tokenizeRow(line)
    if (tokens.length < 4) continue

    const amounts = extractMoneyTokens(tokens).map((t) => normalizeMoneyToken(t)).filter(Boolean)
    if (!amounts.length) continue

    const receivableAmount = amounts[0]
    const receivedAmount = amounts.length >= 2 ? amounts[1] : ''
    const customer = tokens[0] && tokens[0].length <= 30 ? tokens[0] : ''
    const project = tokens[1] && tokens[1].length <= 50 ? tokens[1] : ''
    const owner = tokens[tokens.length - 1] && tokens[tokens.length - 1].length <= 20 ? tokens[tokens.length - 1] : ''

    return { customer, project, receivableAmount, receivedAmount, dueDate: date, owner }
  }

  return null
}

const COLUMN_SYNONYMS = {
  customer: ['客户', '客户名称', 'Customer', 'Client'],
  project: ['项目', '项目名称', 'Project'],
  receivableAmount: ['应收金额', '应收', '应收款', 'Amount Due', 'Receivable'],
  receivedAmount: ['已收金额', '已收', '回款', 'Paid', 'Received'],
  dueDate: ['到期日', '到期', '账期', 'Due Date', 'Due', '截止日'],
  owner: ['负责人', '经办', 'Owner', '负责人/经办'],
}

function detectTableHeader(lines) {
  let best = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const match = scoreHeaderLine(line)
    if (!match) continue
    if (!best || match.score > best.score) best = { headerIndex: i, ...match }
  }
  if (!best) return null
  if (best.columns.length < 3) return null
  return { headerIndex: best.headerIndex, columns: best.columns }
}

function scoreHeaderLine(line) {
  const s = String(line)
  let score = 0
  const positions = []

  for (const [key, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
    let pos = -1
    for (const syn of synonyms) {
      const idx = indexOfFuzzy(s, syn)
      if (idx >= 0 && (pos < 0 || idx < pos)) pos = idx
    }
    if (pos >= 0) {
      score += 1
      positions.push({ key, pos })
    }
  }

  if (score < 3) return null
  positions.sort((a, b) => a.pos - b.pos)
  const columns = positions.map((p) => p.key)

  return { score, columns }
}

function indexOfFuzzy(haystack, needle) {
  const direct = indexOfInsensitive(haystack, needle)
  if (direct >= 0) return direct

  const h = String(haystack)
  const n = String(needle)
  if (!h || !n) return -1

  // Allow spaces between characters to match OCR outputs like "客 户" / "张 三".
  const chars = [...n]
  const pattern = chars.map((c) => escapeRe(c)).join('\\s*')
  try {
    const re = new RegExp(pattern, 'i')
    const m = re.exec(h)
    return m ? m.index : -1
  } catch {
    return -1
  }
}

function looksLikeTableHeader(line) {
  const match = scoreHeaderLine(line)
  return Boolean(match && match.score >= 3)
}

function indexOfInsensitive(haystack, needle) {
  const h = String(haystack)
  const n = String(needle)
  const idx = h.toLowerCase().indexOf(n.toLowerCase())
  return idx
}

function tokenizeRow(line) {
  return String(line)
    .replace(/[|丨]/g, ' ')
    .replace(/[，,、]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

function extractMoneyTokens(tokens) {
  return tokens.filter((t) => /\d/.test(t))
}

function normalizeMoneyToken(token) {
  const m = String(token).replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/) // first numeric chunk
  return m ? m[0] : ''
}

function parseRowByHeader(line, columns) {
  // First, try to split by wide spaces / explicit separators to get cells.
  const rawCells = splitRowIntoCells(line)
    .map((c) => c.replace(/[￥¥]/g, ''))
    .map((c) => c.replace(/元/g, ''))
    .map((c) => c.trim())
    .filter(Boolean)

  let cells = rawCells
  if (cells.length >= columns.length) {
    if (cells.length > columns.length) {
      // Merge extra cells into a text column (project preferred).
      const extra = cells.length - columns.length
      const projectIndex = columns.indexOf('project')
      if (projectIndex >= 0) {
        const merged = cells.slice(projectIndex, projectIndex + extra + 1).join('')
        cells.splice(projectIndex, extra + 1, merged)
      } else {
        const merged = cells.slice(columns.length - 1).join('')
        cells.splice(columns.length - 1, cells.length - (columns.length - 1), merged)
      }
    }

    if (cells.length !== columns.length) return null
  } else {
    // Fallback: token-based parsing with intelligent merging.
    const rawTokens = tokenizeRow(line)
      .map((t) => t.replace(/[￥¥]/g, ''))
      .map((t) => t.replace(/元/g, ''))
      .filter(Boolean)
    if (!rawTokens.length) return null

    cells = buildCellsFromTokens(rawTokens, columns)
    if (!cells) return null
  }

  const out = {
    customer: '',
    project: '',
    receivableAmount: '',
    receivedAmount: '',
    dueDate: '',
    owner: '',
  }

  for (let i = 0; i < columns.length; i++) {
    const key = columns[i]
    const value = cells[i] ?? ''
    if (!key) continue

    if (key === 'receivableAmount' || key === 'receivedAmount') {
      out[key] = normalizeMoneyToken(value)
      continue
    }

    if (key === 'dueDate') {
      out.dueDate = findAnyDate(value) || findAnyDate(line) || ''
      continue
    }

    if (key === 'customer') {
      out.customer = cleanupValue(value)
      continue
    }

    if (key === 'project') {
      out.project = cleanupValue(value)
      continue
    }

    if (key === 'owner') {
      out.owner = cleanupValue(value)
      continue
    }
  }

  return out
}

function splitRowIntoCells(line) {
  const s = String(line)
    .replace(/[|丨]/g, '  ')
    .replace(/\t/g, '  ')
    .replace(/\s{3,}/g, '  ')
    .trim()

  // Try 2+ spaces as column separators.
  const cells = s.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean)
  return cells
}

function buildCellsFromTokens(tokens, columns) {
  // When OCR outputs character-separated tokens like:
  // A 公 司 网 站 开 发 15000 10000 2024.12.31 张 三
  // we anchor typed columns (money/date) by their token positions, then
  // allocate text fragments by the regions between anchors.

  const cleaned = tokens
    .map((t) => String(t).replace(/[￥¥]/g, ''))
    .map((t) => String(t).replace(/元/g, ''))
    .map((t) => t.trim())
    .filter(Boolean)
  if (!cleaned.length) return null

  const cells = new Array(columns.length).fill('')

  const anchors = []
  // Date anchor
  if (columns.includes('dueDate')) {
    const dateSpan = findDateSpan(cleaned)
    if (dateSpan) {
      const [start, end, iso] = dateSpan
      anchors.push({ colIndex: columns.indexOf('dueDate'), start, end })
      cells[columns.indexOf('dueDate')] = iso
    }
  }

  // Money anchors (in row order)
  const moneyCols = columns
    .map((k, idx) => ({ k, idx }))
    .filter(({ k }) => k === 'receivableAmount' || k === 'receivedAmount')

  const moneyTokenIndexes = findMoneyTokenIndexes(cleaned, anchors)
  if (moneyCols.length && moneyTokenIndexes.length < moneyCols.length) return null

  for (let mi = 0; mi < moneyCols.length; mi++) {
    const { idx: colIndex } = moneyCols[mi]
    const tokenIndex = moneyTokenIndexes[mi]
    anchors.push({ colIndex, start: tokenIndex, end: tokenIndex + 1 })
    cells[colIndex] = normalizeMoneyToken(cleaned[tokenIndex])
  }

  anchors.sort((a, b) => a.colIndex - b.colIndex)

  // Allocate text regions between anchors based on column order.
  const isTextCol = (k) => k === 'customer' || k === 'project' || k === 'owner'

  for (let i = 0; i < columns.length; ) {
    const key = columns[i]
    if (!isTextCol(key) || cells[i]) {
      i++
      continue
    }

    const prev = findPrevAnchor(anchors, i)
    const next = findNextAnchor(anchors, i)
    const regionStart = prev ? prev.end : 0
    const regionEnd = next ? next.start : cleaned.length

    const groupKeys = []
    let j = i
    while (j < columns.length) {
      const kj = columns[j]
      if (!isTextCol(kj) || cells[j]) break
      const pj = findPrevAnchor(anchors, j)
      const nj = findNextAnchor(anchors, j)
      const rs = pj ? pj.end : 0
      const re = nj ? nj.start : cleaned.length
      if (rs !== regionStart || re !== regionEnd) break
      groupKeys.push(kj)
      j++
    }

    const regionTokens = cleaned.slice(regionStart, regionEnd)
    const assignment = assignTextRegion(regionTokens, groupKeys)

    for (let k = 0; k < groupKeys.length; k++) {
      const colIdx = i + k
      if (!cells[colIdx]) cells[colIdx] = assignment[groupKeys[k]] || ''
    }

    i = j
  }

  return cells
}

function findDateSpan(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t1 = tokens[i]
    if (findAnyDate(t1)) return [i, i + 1, findAnyDate(t1)]

    // Only attempt multi-token joins if the starting token looks like a date fragment.
    // This prevents cases like "10000 2024.12.31" from treating "10000" as part of a date span.
    if (!looksLikeDateStartToken(t1)) continue

    const t2 = tokens[i + 1]
    const t3 = tokens[i + 2]
    const j2 = [t1, t2].filter(Boolean).join('')
    const j3 = [t1, t2, t3].filter(Boolean).join('')
    const d2 = findAnyDate(j2)
    if (d2) return [i, i + 2, d2]
    const d3 = findAnyDate(j3)
    if (d3) return [i, i + 3, d3]
  }
  return null
}

function looksLikeDateStartToken(t) {
  const s = String(t || '').trim()
  if (!s) return false
  if (findAnyDate(s)) return true
  if (/[\-/.年]/.test(s)) return true
  // 4-digit year token like 2024
  if (/^20\d{2}$/.test(s)) return true
  return false
}

function findMoneyTokenIndexes(tokens, anchors) {
  const blocked = new Set()
  for (const a of anchors) {
    for (let i = a.start; i < a.end; i++) blocked.add(i)
  }

  const idxs = []
  for (let i = 0; i < tokens.length; i++) {
    if (blocked.has(i)) continue
    const n = normalizeMoneyToken(tokens[i])
    if (!n) continue
    if (Number(n) === 0) {
      idxs.push(i)
      continue
    }
    // avoid picking up date fragments like "2024" or "12" if OCR split them
    if (n.length === 4 && /^20\d{2}$/.test(n)) continue
    if (n.length <= 2 && Number(n) <= 31) continue
    idxs.push(i)
  }
  return idxs
}

function findPrevAnchor(anchors, colIndex) {
  let prev = null
  for (const a of anchors) {
    if (a.colIndex < colIndex) prev = a
  }
  return prev
}

function findNextAnchor(anchors, colIndex) {
  for (const a of anchors) {
    if (a.colIndex > colIndex) return a
  }
  return null
}

function assignTextRegion(tokens, keys) {
  const out = {}
  const usable = tokens
    .filter(Boolean)
    .filter((t) => !normalizeMoneyToken(t) && !findAnyDate(t))
  if (!usable.length) {
    for (const k of keys) out[k] = ''
    return out
  }

  if (keys.length === 1) {
    out[keys[0]] = joinTextTokens(usable)
    return out
  }

  if (keys.length >= 2 && keys[0] === 'customer' && keys[1] === 'project') {
    const cut = findCustomerCutIndex(usable)
    out.customer = joinTextTokens(usable.slice(0, cut))
    out.project = joinTextTokens(usable.slice(cut))
    for (const k of keys.slice(2)) out[k] = ''
    return out
  }

  // Generic split
  const parts = []
  for (let i = 0; i < keys.length; i++) parts.push([])
  for (let i = 0; i < usable.length; i++) {
    const bucket = Math.min(keys.length - 1, Math.floor((i / usable.length) * keys.length))
    parts[bucket].push(usable[i])
  }
  for (let i = 0; i < keys.length; i++) {
    out[keys[i]] = joinTextTokens(parts[i])
  }
  return out
}

function findCustomerCutIndex(tokens) {
  if (!tokens.length) return 0
  const companySuffixes = ['有限公司', '有限责任公司', '公司', '集团', 'Co', 'Ltd', 'Inc']

  let joined = ''
  for (let i = 0; i < tokens.length; i++) {
    joined += tokens[i]
    for (const suf of companySuffixes) {
      if (joined.toLowerCase().endsWith(String(suf).toLowerCase())) return i + 1
    }
  }

  // If OCR split into single chars, take up to 6 as customer.
  const allSmall = tokens.slice(0, Math.min(tokens.length, 6)).every((t) => String(t).length <= 2)
  if (allSmall && tokens.length > 2) return Math.min(3, tokens.length)

  return 1
}

function looksLikeNameFragment(t) {
  const s = String(t)
  if (!s) return false
  if (/^\d/.test(s)) return false
  if (findAnyDate(s)) return false
  if (normalizeMoneyToken(s)) return false
  // Chinese single-character name fragments or short alpha fragments
  return s.length <= 2
}

function joinTextTokens(tokens) {
  const s = tokens
    .filter(Boolean)
    .map((t) => String(t).replace(/\s+/g, ''))
    .join('')
  return cleanupValue(s)
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseTableFromLayout(words) {
  if (!Array.isArray(words) || !words.length) return null

  const cleaned = words
    .map((w) => ({
      text: String(w.text || '').trim(),
      confidence: Number.isFinite(Number(w.confidence)) ? Number(w.confidence) : null,
      bbox: w.bbox,
    }))
    .filter((w) => w.text && w.bbox)
    .filter((w) => !/^[-—_]+$/.test(w.text))

  if (!cleaned.length) return null

  const rows = clusterWordsIntoRows(cleaned)
  if (rows.length < 2) return null

  const headerInfo = detectHeaderRowFromWords(rows)
  if (!headerInfo) return null

  const { headerRowIndex, orderedKeys, keyXCenters } = headerInfo
  if (!orderedKeys.length || orderedKeys.length < 3) return null

  const boundaries = buildColumnBoundaries(orderedKeys, keyXCenters)

  const drafts = []
  const confidences = []

  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const rowWords = rows[r]
    if (!rowWords?.length) continue

    // Skip possible repeated header lines
    if (rowLooksLikeHeader(rowWords)) continue

    const row = mapRowWordsToDraft(rowWords, orderedKeys, boundaries)
    if (!row) continue

    // Sanity: at least have some meaningful fields
    const hasKeyFields = Boolean(row.draft.customer || row.draft.project || row.draft.owner)
    const hasTyped = Boolean(row.draft.dueDate || row.draft.receivableAmount || row.draft.receivedAmount)
    if (!hasKeyFields || !hasTyped) continue

    drafts.push(row.draft)
    confidences.push(row.confidence)
    if (drafts.length >= 50) break
  }

  if (!drafts.length) return null
  return { drafts, confidences }
}

function clusterWordsIntoRows(words) {
  const ws = [...words]
    .map((w) => ({
      ...w,
      cx: (w.bbox.left + w.bbox.right) / 2,
      cy: (w.bbox.top + w.bbox.bottom) / 2,
      h: w.bbox.bottom - w.bbox.top,
    }))
    .sort((a, b) => a.cy - b.cy)

  const heights = ws.map((w) => w.h).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b)
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 12
  const rowGap = Math.max(6, medianH * 0.8)

  const rows = []
  for (const w of ws) {
    const last = rows[rows.length - 1]
    if (!last) {
      rows.push([w])
      continue
    }

    const lastCy = average(last.map((x) => x.cy))
    if (Math.abs(w.cy - lastCy) <= rowGap) {
      last.push(w)
    } else {
      rows.push([w])
    }
  }

  // Sort within each row by x
  for (const row of rows) row.sort((a, b) => a.cx - b.cx)
  return rows
}

function average(nums) {
  const arr = nums.filter((n) => Number.isFinite(n))
  if (!arr.length) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function rowText(rowWords) {
  return rowWords.map((w) => w.text).join(' ')
}

function detectHeaderRowFromWords(rows) {
  let best = null

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const headerMatch = scoreHeaderRowFromWords(row)
    if (!headerMatch) continue
    if (!best || headerMatch.score > best.score) best = { headerRowIndex: i, ...headerMatch }
  }

  return best
}

function scoreHeaderRowFromWords(rowWords) {
  if (!rowWords?.length) return null
  const joined = rowText(rowWords)

  const found = []
  for (const [key, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
    for (const syn of synonyms) {
      if (indexOfInsensitive(joined, syn) >= 0) {
        found.push(key)
        break
      }
    }
  }

  const unique = [...new Set(found)]
  if (unique.length < 3) return null

  // Determine each key's x center in header row.
  const keyXCenters = {}
  for (const key of unique) {
    const synonyms = COLUMN_SYNONYMS[key]
    const candidates = rowWords.filter((w) => synonyms.some((s) => indexOfInsensitive(w.text, s) >= 0))
    if (!candidates.length) continue
    keyXCenters[key] = average(candidates.map((c) => c.cx))
  }

  const orderedKeys = Object.entries(keyXCenters)
    .sort((a, b) => a[1] - b[1])
    .map(([k]) => k)

  return {
    score: unique.length,
    orderedKeys,
    keyXCenters,
  }
}

function rowLooksLikeHeader(rowWords) {
  const joined = rowText(rowWords)
  let count = 0
  for (const synonyms of Object.values(COLUMN_SYNONYMS)) {
    if (synonyms.some((s) => indexOfInsensitive(joined, s) >= 0)) count++
  }
  return count >= 3
}

function buildColumnBoundaries(orderedKeys, keyXCenters) {
  const xs = orderedKeys.map((k) => keyXCenters[k]).filter((n) => Number.isFinite(n))
  const boundaries = []
  for (let i = 0; i < xs.length - 1; i++) {
    boundaries.push((xs[i] + xs[i + 1]) / 2)
  }
  return boundaries
}

function assignWordToColumnIndex(cx, boundaries) {
  for (let i = 0; i < boundaries.length; i++) {
    if (cx < boundaries[i]) return i
  }
  return boundaries.length
}

function mapRowWordsToDraft(rowWords, orderedKeys, boundaries) {
  const cols = new Array(orderedKeys.length).fill(null).map(() => [])

  for (const w of rowWords) {
    const idx = assignWordToColumnIndex(w.cx, boundaries)
    if (idx >= 0 && idx < cols.length) cols[idx].push(w)
  }

  const draft = {
    customer: '',
    project: '',
    receivableAmount: '',
    receivedAmount: '',
    dueDate: '',
    owner: '',
  }

  const confidence = {
    customer: 'low',
    project: 'low',
    receivableAmount: 'low',
    receivedAmount: 'low',
    dueDate: 'low',
    owner: 'low',
  }

  for (let i = 0; i < orderedKeys.length; i++) {
    const key = orderedKeys[i]
    const ws = (cols[i] || []).sort((a, b) => a.cx - b.cx)
    if (!ws.length) continue

    const cellText = ws.map((x) => x.text).join('')
    const c = meanConfidence(ws)

    if (key === 'customer' || key === 'project' || key === 'owner') {
      draft[key] = cleanupValue(cellText)
      confidence[key] = confLabel(c)
      continue
    }

    if (key === 'receivableAmount' || key === 'receivedAmount') {
      draft[key] = normalizeMoneyToken(cellText)
      confidence[key] = confLabel(c)
      continue
    }

    if (key === 'dueDate') {
      draft.dueDate = findAnyDate(cellText) || ''
      confidence.dueDate = confLabel(c)
      continue
    }
  }

  // If amounts got swapped due to missing header columns, try a heuristic
  // using relative order in the row.
  if (!draft.receivableAmount || !draft.receivedAmount) {
    // no-op; leave for manual confirmation
  }

  // Sanity: avoid purely numeric customer
  if (draft.customer && /^\d+$/.test(draft.customer)) draft.customer = ''

  return { draft, confidence }
}

function meanConfidence(ws) {
  const nums = ws
    .map((w) => w.confidence)
    .filter((n) => Number.isFinite(n))
  if (!nums.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function confLabel(c) {
  if (!Number.isFinite(c)) return 'medium'
  if (c >= 85) return 'high'
  if (c >= 60) return 'medium'
  return 'low'
}
