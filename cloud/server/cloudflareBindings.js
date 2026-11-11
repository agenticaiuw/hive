let bindings = null

export function setCloudflareBindings(nextBindings) {
  bindings = nextBindings || null

  for (const [name, value] of Object.entries(bindings || {})) {
    if (typeof value === 'string') {
      process.env[name] = value
    }
  }
}

export function getCloudflareBindings() {
  return bindings
}
