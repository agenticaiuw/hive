const STORAGE_KEY = 'aiPendantSimulator'

function createDefaultState() {
  return {
    reminders: [],
    drafts: [],
    calendar: [
      {
        id: 'calendar-1',
        title: 'Research meeting',
        date: 'tomorrow',
        time: '2:00 PM',
      },
      {
        id: 'calendar-2',
        title: 'SAIL program work session',
        date: 'tomorrow',
        time: '4:00 PM',
      },
      {
        id: 'calendar-3',
        title: 'Prototype review',
        date: 'today',
        time: '11:30 AM',
      },
      {
        id: 'calendar-4',
        title: 'Project planning block',
        date: 'today',
        time: '3:00 PM',
      },
    ],
    activityLog: [],
    lastCalendarCheck: '',
  }
}

export function loadSimulatorState() {
  const defaultState = createDefaultState()
  const storedValue = localStorage.getItem(STORAGE_KEY)

  if (!storedValue) {
    return defaultState
  }

  try {
    const parsedState = JSON.parse(storedValue)

    return {
      ...defaultState,
      ...parsedState,
      reminders: parsedState.reminders ?? [],
      drafts: parsedState.drafts ?? [],
      calendar: parsedState.calendar?.length
        ? parsedState.calendar
        : defaultState.calendar,
      activityLog: parsedState.activityLog ?? [],
    }
  } catch {
    return defaultState
  }
}

export function saveSimulatorState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}
