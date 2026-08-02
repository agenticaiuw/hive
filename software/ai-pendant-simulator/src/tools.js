export function executePlan(plan, currentState, command) {
  const timestamp = new Date()
  const initialResult = {
    state: currentState,
    summaries: [],
    events: [],
  }

  const result = plan.actions.reduce(
    (nextResult, action) =>
      executeAction(action, nextResult.state, command, timestamp, nextResult),
    initialResult,
  )

  return {
    state: result.state,
    response: {
      title:
        plan.actions.length > 1
          ? `${plan.actions.length} actions completed`
          : 'Action completed',
      body: result.summaries.join(' '),
      events: result.events,
    },
    message:
      plan.actions.length > 1
        ? `${plan.actions.length} mock actions completed.`
        : `${result.summaries[0]} completed.`,
  }
}

function executeAction(action, currentState, command, timestamp, aggregate) {
  if (action.tool === 'draft_email') {
    const draft = {
      id: crypto.randomUUID(),
      ...action.parameters,
      createdAt: timestamp.toISOString(),
    }
    const activity = createActivity(
      `Draft email created - ${draft.to}`,
      command,
      timestamp,
    )

    return {
      ...aggregate,
      state: {
        ...currentState,
        drafts: [draft, ...currentState.drafts],
        activityLog: [activity, ...currentState.activityLog],
      },
      summaries: [
        ...aggregate.summaries,
        `Email draft for ${draft.to} was added.`,
      ],
    }
  }

  if (action.tool === 'create_reminder') {
    const reminder = {
      id: crypto.randomUUID(),
      ...action.parameters,
      createdAt: timestamp.toISOString(),
    }
    const activity = createActivity(
      `Reminder created - ${reminder.title}`,
      command,
      timestamp,
    )

    return {
      ...aggregate,
      state: {
        ...currentState,
        reminders: [reminder, ...currentState.reminders],
        activityLog: [activity, ...currentState.activityLog],
      },
      summaries: [
        ...aggregate.summaries,
        `Reminder "${reminder.title}" was set for ${reminder.time}.`,
      ],
    }
  }

  if (action.tool === 'check_calendar') {
    const events = findEventsForDate(currentState.calendar, action.parameters.date)
    const activity = createActivity(
      `Calendar checked - ${action.parameters.date}`,
      command,
      timestamp,
    )

    return {
      ...aggregate,
      state: {
        ...currentState,
        lastCalendarCheck: action.parameters.date,
        activityLog: [activity, ...currentState.activityLog],
      },
      summaries: [
        ...aggregate.summaries,
        events.length
          ? `Found ${events.length} event${events.length > 1 ? 's' : ''} for ${action.parameters.date}.`
          : `No events found for ${action.parameters.date}.`,
      ],
      events: [...aggregate.events, ...events],
    }
  }

  return aggregate
}

function findEventsForDate(calendar, requestedDate) {
  const normalizedRequest = requestedDate.toLowerCase()

  return calendar.filter((event) => event.date.toLowerCase() === normalizedRequest)
}

function createActivity(label, command, timestamp) {
  return {
    id: crypto.randomUUID(),
    label,
    command,
    time: timestamp.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    }),
    createdAt: timestamp.toISOString(),
  }
}
