const STORAGE_KEY = 'ar-reminder-demo-v1'

export function getDefaultState() {
  return {
    version: 1,
    settings: {
      dueSoonDays: 7,
    },
    invoices: [],
    sentKeys: {},
    reminderLogs: [],
  }
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return getDefaultState()
    const parsed = JSON.parse(raw)
    return normalizeState(parsed)
  } catch {
    return getDefaultState()
  }
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function clearState() {
  localStorage.removeItem(STORAGE_KEY)
}

export function exportStateToJson(state) {
  return JSON.stringify(state, null, 2)
}

export function importStateFromJsonText(jsonText) {
  const parsed = JSON.parse(jsonText)
  return normalizeState(parsed)
}

function normalizeState(input) {
  const defaults = getDefaultState()
  const state = {
    ...defaults,
    ...input,
    settings: {
      ...defaults.settings,
      ...(input?.settings ?? {}),
    },
    invoices: Array.isArray(input?.invoices) ? input.invoices : [],
    sentKeys: isPlainObject(input?.sentKeys) ? input.sentKeys : {},
    reminderLogs: Array.isArray(input?.reminderLogs) ? input.reminderLogs : [],
  }

  // Ensure stable types
  state.settings.dueSoonDays = Number(state.settings.dueSoonDays) || 7
  return state
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
