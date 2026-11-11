import crypto from 'node:crypto'
import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'
import { normalizeSource } from './evidenceCapsules.js'
import { prepareFormPreview, prepareMessagePreview } from './formPreview.js'
import {
  DEFAULT_LENSES,
  inspectInParallel,
  panelPreflight,
  scanOpenTabs,
} from './handleThisPanel.js'
import { VERDICT, reconcileAll, settledValues } from './handleThisReconcile.js'

/*
 * "Handle this."
 *
 * Two proposals that turn out to be one mechanism. "Gather the details across
 * my logged-in tabs and fill the form" and "have several agents inspect this
 * and tell me what they agree and disagree on" are the same act done for two
 * different outputs: read one question off several places, decide what the
 * readings amount to, and then either say it or use it.
 *
 * Building them together is what makes the first one safe. A gather-and-fill
 * that has no notion of disagreement resolves a conflict by accident — it takes
 * whichever tab it read last and types that into the form, and the owner
 * approves a number that two of their own tabs disagreed about, with nothing
 * anywhere recording that they did. Here a disputed value is simply not a value:
 * it never enters the draft, and the draft says so.
 *
 * ── What this refuses to do ───────────────────────────────────────────────
 *
 * NOTHING IS EVER SUBMITTED. Not by this module and not by anything it calls.
 * The draft goes to formPreview.js, which holds it behind a confirm code the
 * owner has to read back; `approveFormPreview` and `markFormPreviewSubmitted`
 * are not imported here and must never be. The browser side cannot act either:
 * handleThisPanel's allowlist contains no click, type or press, and
 * browserPage.runBrowserActions throws before the trip on anything outside it.
 *
 * NOTHING IS EVER OPENED THAT WAS NOT ALREADY OPEN. Gathering reads the tabs
 * the owner already has, plus the one page they named. "Across my logged-in
 * tabs" is a description of what is already in front of them, not a licence to
 * go and establish sessions.
 *
 * NO DISAGREEMENT IS RESOLVED BY PREFERENCE. See handleThisReconcile.js for
 * the whole argument; the short version is that the only readings dropped are
 * ones that cannot be shown at all, and among readings that can be shown, a
 * conflict is reported rather than settled.
 */

const STORE_PATH = path.join(workspacePath, '.pendant-handle-this.json')

/* An investigation is a few hundred bytes of verdicts plus its readings. Kept
 * so "why did it fill that" is answerable tomorrow, bounded so it cannot become
 * the largest file in the workspace. */
const MAX_INVESTIGATIONS = 40

/*
 * Reading every open tab for every question is how a five-tab question becomes
 * a thirty-read investigation and two minutes of the owner's browser. The cap
 * is small on purpose: past three or four sources, the extra readings are
 * almost always the same site again and they add tally without adding evidence
 * — which is precisely the weight the reconciler refuses to count anyway.
 */
const MAX_SOURCES = 4

const isValidStore = (value) => value && Array.isArray(value.investigations)
const emptyStore = () => ({ version: 1, investigations: [] })

function load(filePath) {
  ensureJsonStore(filePath, emptyStore(), { validate: isValidStore })
  return readJsonWithRecovery(filePath, { fallback: emptyStore(), validate: isValidStore })
}

function save(store, filePath) {
  return writeJsonAtomic(filePath, store, { validate: isValidStore })
}

export const handleThisLocation = () => STORE_PATH

/* ------------------------------------------------------------- questions */

/**
 * Normalize what the caller wants to know.
 *
 * A question needs a key and at least one way to find it. A question with
 * neither patterns nor labels would match nothing on every page and then be
 * reported as a unanimous "not found", which reads like a fact about the pages
 * rather than about the request.
 */
export function normalizeQuestions(input = []) {
  const questions = []

  for (const entry of input) {
    const key = String(entry?.key ?? '').trim()
    if (!key) throw new Error('Every question needs a key.')

    const patterns = entry.patterns ?? []
    const labels = entry.labels ?? []
    if (!patterns.length && !labels.length) {
      throw new Error(`Question "${key}" has no patterns and no labels, so nothing could ever match it.`)
    }

    questions.push({
      key,
      prompt: entry.prompt ? String(entry.prompt).slice(0, 200) : key,
      patterns,
      labels,
    })
  }

  if (!questions.length) throw new Error('Ask at least one question.')
  return questions
}

/* -------------------------------------------------------------- gathering */

/**
 * Read one question off several places and say what they add up to.
 *
 * The sources are the owner's open tabs (filtered to the requested origins)
 * plus, when given, an anchor page — the thing they were looking at in Safari
 * when they said "handle this". Each source is inspected by the whole lens
 * panel, and then EVERY reading from EVERY source is reconciled together in one
 * pool rather than per page.
 *
 * Pooling is the part that matters. Reconciling per page and then merging the
 * page verdicts would hide the interesting case entirely: two tabs that each
 * agree with themselves and disagree with each other would come back as two
 * confident answers, and whichever merge ran last would win. Pooled, that is a
 * `page` conflict with both sides and their evidence, which is the true shape.
 */
export async function gatherAcrossTabs(
  {
    ask = null,
    questions = [],
    origins = [],
    anchorUrl = null,
    lenses = DEFAULT_LENSES,
    reload = true,
    maxSources = MAX_SOURCES,
  } = {},
  { inspect = inspectInParallel, scan = scanOpenTabs, status = null, now = () => Date.now() } = {},
) {
  const asked = normalizeQuestions(questions)
  const preflight = await panelPreflight(status ? { status } : {})
  const investigationId = `hti_${crypto.randomUUID()}`
  const startedAt = new Date(now()).toISOString()

  if (!preflight.online) {
    /*
     * Offline: one recall pass, no browser traffic at all.
     *
     * Deliberately not "queue the reads and answer when Safari comes back".
     * browserBridge's own header documents where that goes — commands outlive
     * the caller and fire into the owner's browser hours later — and a
     * question asked now is not worth tabs opening at an unrelated moment.
     */
    const recalled = await inspect(
      { url: anchorUrl || 'https://example.invalid/', questions: asked, lenses, reload },
      { status: { online: false, devices: [] }, now },
    ).catch(() => null)

    const readings = recalled?.readings ?? []
    return {
      investigationId,
      ask,
      startedAt,
      status: 'recalled',
      preflight,
      questions: asked,
      sources: [],
      readings,
      ...reconcileAll({ questions: asked, readings }),
      caveats: recalled?.caveats ?? [
        'No browser is connected and there was nothing remembered about these pages, so nothing here was read and nothing was queued to read later.',
      ],
    }
  }

  const scanned = await scan({ origins })
  const anchor = anchorUrl
    ? [{ url: anchorUrl, host: normalizeSource(anchorUrl).host, origin: normalizeSource(anchorUrl).origin, anchor: true }]
    : []

  /*
   * The anchor first, deduplicated against the tab list.
   *
   * The page the owner was looking at is the one their "this" refers to, so it
   * must be inspected even when the tab scan would have ranked it last — and it
   * must not be inspected twice when it is also an open tab, because two
   * inspections of one page are the fake corroboration the reconciler spends
   * most of its effort refusing to be fooled by.
   */
  const seen = new Set(anchor.map((entry) => normalizeSource(entry.url).key))
  const sources = [
    ...anchor,
    ...scanned.tabs.filter((tab) => {
      const key = normalizeSource(tab.url).key
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  ].slice(0, Math.max(1, maxSources))

  const dropped = scanned.tabs.length + anchor.length - sources.length

  const readings = []
  const inspected = []
  const caveats = [...preflight.caveats]

  /*
   * The browser state is resolved once and handed down.
   *
   * Left to itself each inspection re-runs its own preflight, which is a
   * loopback call to the agent per source — but worse than the cost, it means
   * four sources can be judged against four different answers to "is the
   * browser there". One resolution for the whole investigation is both cheaper
   * and the only way the readings are comparable.
   */
  const sharedStatus = status ?? {
    online: preflight.online,
    devices: preflight.devices.map((device) => ({ ...device, online: true })),
  }

  for (const source of sources) {
    /*
     * Sources in sequence, lenses in parallel within a source.
     *
     * The extension claims one command per poll, so inspecting two pages
     * concurrently would not run them concurrently — it would only interleave
     * two navigations in one browser, which is the tab fight this design exists
     * to avoid. Serial per page, batched per page, is both faster and safe.
     */
    try {
      const outcome = await inspect(
        { url: source.url, questions: asked, lenses, reload, label: source.host ?? 'source' },
        { status: sharedStatus, now },
      )
      readings.push(...outcome.readings)
      inspected.push({
        url: outcome.url,
        requestedUrl: source.url,
        host: source.host ?? null,
        anchor: Boolean(source.anchor),
        disposition: outcome.disposition ?? null,
        lenses: outcome.lenses,
        ok: true,
      })
      caveats.push(...(outcome.caveats ?? []))
    } catch (error) {
      /*
       * A source that could not be read is recorded as a source that could not
       * be read. Dropping it silently would let a two-source question quietly
       * become a one-source question and still be described as corroborated.
       */
      inspected.push({
        url: source.url,
        host: source.host ?? null,
        anchor: Boolean(source.anchor),
        ok: false,
        error: String(error?.message ?? error),
      })
      caveats.push(
        `${source.url} could not be read (${String(error?.message ?? error)}), so nothing below is standing on it.`,
      )
    }
  }

  if (dropped > 0) {
    caveats.push(
      `${dropped} other open tab(s) matched the scope but were not read — this reads at most ${maxSources} sources per question.`,
    )
  }

  const reconciled = reconcileAll({ questions: asked, readings })

  return {
    investigationId,
    ask,
    startedAt,
    status: 'gathered',
    preflight,
    questions: asked,
    sources: inspected,
    skippedTabs: scanned.skipped,
    readings,
    ...reconciled,
    /* Deduplicated: every source's inspection repeats the shared preflight
     * caveats, and four copies of "two browsers are connected" reads as four
     * problems. */
    caveats: [...new Set(caveats)],
  }
}

/* ------------------------------------------------------------- the report */

/**
 * The investigation as something the owner can be told, out loud.
 *
 * Agreement and disagreement are separate sections rather than one ranked list
 * on purpose. A single list sorted by confidence puts the disputed items at the
 * bottom where they read as footnotes, and the entire point of this feature is
 * that the disputed items are the finding.
 */
export function describeInvestigation(investigation) {
  const verdicts = investigation.verdicts ?? []
  const agreed = verdicts.filter((item) => item.status === VERDICT.agreed)
  const single = verdicts.filter((item) => item.status === VERDICT.single)
  const disputed = verdicts.filter((item) => item.status === VERDICT.disputed)
  const missing = verdicts.filter((item) => item.status === VERDICT.unanswered)

  const lines = []

  const sourceCount = (investigation.sources ?? []).filter((source) => source.ok).length
  const lensCount = (investigation.sources ?? []).find((source) => source.ok)?.lenses?.length ?? 0
  if (investigation.status === 'recalled') {
    lines.push('Nothing was read just now — no browser is connected. This is from remembered evidence.')
  } else {
    lines.push(
      `Read ${sourceCount} source(s) through ${lensCount} lens(es) each.`,
    )
  }

  if (agreed.length) {
    lines.push('They agree on:')
    for (const verdict of agreed) lines.push(`  • ${verdict.narrative}`)
  }

  if (disputed.length) {
    /* Named as the headline, not as an exception. */
    lines.push(`They disagree on ${disputed.length}:`)
    for (const verdict of disputed) {
      lines.push(`  • ${verdict.narrative}`)
      for (const side of verdict.conflict?.sides ?? []) {
        const where = side.sourceKeys?.filter(Boolean).join(', ') || 'an unrecorded page'
        lines.push(`      "${side.answer}" — ${side.inspectors.join(', ')} on ${where}`)
      }
    }
  }

  if (single.length) {
    lines.push('Only one reading found these, so nothing checked them:')
    for (const verdict of single) lines.push(`  • ${verdict.narrative}`)
  }

  if (missing.length) {
    lines.push(`Nothing found: ${missing.map((verdict) => verdict.questionKey).join(', ')}.`)
  }

  for (const caveat of investigation.caveats ?? []) lines.push(`  ⚠ ${caveat}`)

  return lines.join('\n')
}

/* ---------------------------------------------------------------- drafting */

/*
 * Which questions a draft is standing on, and which it refused to stand on.
 *
 * `settledValues` does the deciding; this maps question keys onto whatever the
 * draft calls them and keeps the two halves of the answer — what went in, what
 * was held back — in one object so a caller cannot read one without the other.
 */
function bindValues(verdicts, mapping) {
  const { values, withheld } = settledValues(verdicts)
  const bound = {}
  const unbound = []

  for (const [target, questionKey] of Object.entries(mapping ?? {})) {
    if (Object.hasOwn(values, questionKey)) {
      bound[target] = values[questionKey]
      continue
    }
    const reason = withheld.find((entry) => entry.key === questionKey)
    unbound.push({
      field: target,
      questionKey,
      why: reason?.why ?? 'no reading produced a value for this',
      narrative: reason?.narrative ?? null,
    })
  }

  return { bound, unbound, withheld }
}

/**
 * Gather, reconcile, and draft — without sending anything.
 *
 * `form` fills a form on a page and stops before the submit; `message` drafts a
 * message and stops before the send. Both go through formPreview.js, which
 * already owns the literal payload, the confirm code and the refusal to submit
 * — this deliberately does not build a second preview beside it, because two
 * previews of one act is two things the owner has to notice disagree.
 *
 * A disputed value never reaches either. For a form it is left out, so the page
 * shows the field empty and formFill reports it as still required. For a
 * message the placeholder stays literally unresolved in the body, which is
 * formPreview's own designed behaviour for exactly this — an unresolved
 * `{{order_total}}` in front of the owner is far better than a plausible number
 * that two of their tabs disagreed about.
 */
export async function handleThis(
  {
    ask = null,
    questions = [],
    origins = [],
    anchorUrl = null,
    lenses = DEFAULT_LENSES,
    reload = true,
    maxSources = MAX_SOURCES,
    form = null,
    message = null,
    note = null,
  } = {},
  {
    gather = gatherAcrossTabs,
    prepareForm = prepareFormPreview,
    prepareMessage = prepareMessagePreview,
    filePath = STORE_PATH,
    previewPath = undefined,
    ledgerPath = null,
    now = () => Date.now(),
    inspect = undefined,
    scan = undefined,
    status = null,
  } = {},
) {
  if (form && message) {
    throw new Error('One act at a time: pass either a form to fill or a message to draft.')
  }

  const investigation = await gather(
    { ask, questions, origins, anchorUrl, lenses, reload, maxSources },
    { ...(inspect ? { inspect } : {}), ...(scan ? { scan } : {}), status, now },
  )

  const record = {
    ...investigation,
    note: note ? String(note).slice(0, 400) : null,
    draft: null,
    blocked: [],
    /* Said in the record itself, not only in the docs, because this object is
     * what a later reader will find. */
    submitted: false,
  }

  if (!form && !message) {
    persist(record, filePath)
    return { ...record, report: describeInvestigation(record) }
  }

  const mapping = form ? (form.fields ?? {}) : (message.fields ?? {})
  const { bound, unbound } = bindValues(investigation.verdicts ?? [], mapping)

  record.blocked = unbound

  /*
   * A draft whose every value is disputed is not drafted.
   *
   * Producing an empty form preview here would put a "ready for your approval"
   * object in front of the owner whose entire content is missing — an approval
   * prompt for nothing, which trains the reflex this whole flow depends on them
   * not having.
   */
  if (Object.keys(mapping).length && !Object.keys(bound).length) {
    record.status = 'blocked'
    record.caveats = [
      ...(record.caveats ?? []),
      'Nothing was drafted: not one of the values this needed came back settled.',
    ]
    persist(record, filePath)
    return { ...record, report: describeInvestigation(record) }
  }

  const previewOptions = {
    ...(previewPath ? { filePath: previewPath } : {}),
    ledgerPath,
    now: now(),
  }

  try {
    const preview = form
      ? await prepareForm(
          {
            url: form.url,
            values: { ...(form.values ?? {}), ...bound },
            formSelector: form.formSelector ?? 'form',
            name: form.name ?? ask ?? 'handle this',
            capture: Boolean(form.capture),
            reload: form.reload ?? true,
            note: draftNote(unbound, note),
            sessionId: investigation.investigationId,
          },
          previewOptions,
        )
      : await prepareMessage(
          {
            to: message.to,
            cc: message.cc ?? [],
            bcc: message.bcc ?? [],
            subject: message.subject ?? '',
            body: message.body ?? '',
            /* Placeholders resolve from settled values only. An unsettled key
             * is absent, so `{{key}}` survives into the drafted body visibly. */
            values: { ...(message.values ?? {}), ...bound },
            name: message.name ?? ask ?? 'handle this',
            note: draftNote(unbound, note),
            sourceUrl: anchorUrl,
            sessionId: investigation.investigationId,
          },
          previewOptions,
        )

    record.draft = {
      kind: form ? 'form' : 'message',
      previewId: preview.id,
      status: preview.status,
      payload: preview.payload,
      approval: preview.approval,
      caveats: preview.caveats ?? [],
      /* Which evidence each filled value is standing on, so "why is that in the
       * form" resolves to a capsule rather than to a shrug. */
      standingOn: evidenceBehind(investigation.verdicts ?? [], mapping),
    }
    record.status = 'drafted'
  } catch (error) {
    record.status = 'draft-failed'
    record.caveats = [
      ...(record.caveats ?? []),
      `The draft was not made (${String(error?.message ?? error)}). Nothing was filled and nothing was sent.`,
    ]
  }

  persist(record, filePath)
  return { ...record, report: describeInvestigation(record), willHappen: willHappen(record) }
}

function draftNote(unbound, note) {
  const parts = []
  if (note) parts.push(String(note))
  if (unbound.length) {
    parts.push(
      `Left blank because the readings did not settle: ${unbound.map((entry) => entry.field).join(', ')}.`,
    )
  }
  return parts.join(' ') || null
}

function evidenceBehind(verdicts, mapping) {
  const byKey = new Map(verdicts.map((verdict) => [verdict.questionKey, verdict]))

  return Object.entries(mapping ?? {})
    .map(([field, questionKey]) => {
      const verdict = byKey.get(questionKey)
      if (!verdict || verdict.status === VERDICT.disputed || verdict.status === VERDICT.unanswered) {
        return null
      }
      return {
        field,
        questionKey,
        value: verdict.answer,
        corroboration: verdict.corroboration,
        capsuleIds: (verdict.voices ?? []).flatMap((voice) => voice.capsuleIds ?? []),
        readBy: (verdict.voices ?? []).flatMap((voice) => voice.inspectors ?? []),
      }
    })
    .filter(Boolean)
}

/**
 * "Show me exactly what will happen before it happens."
 *
 * One object, and its first field is the answer to "has anything happened yet".
 * The literal payload is formPreview's — reprinting it here in a friendlier
 * shape would be a second description of one act, and the owner would end up
 * approving whichever of the two they happened to read.
 */
export function willHappen(record) {
  const draft = record?.draft
  if (!draft) {
    return {
      soFar: 'Pages were read. Nothing was filled, drafted, or sent.',
      next: null,
      awaiting: null,
      submitted: false,
    }
  }

  return {
    soFar:
      draft.kind === 'form'
        ? 'The form on the page was filled in front of you. Nothing was submitted.'
        : 'A message was drafted and held. Nothing was sent.',
    next:
      draft.kind === 'form'
        ? 'If you approve, one click on the page\'s own submit control — and only that.'
        : 'If you approve, this message is handed to Mail exactly as printed.',
    payload: draft.payload,
    /* Repeated from the preview because a caller that only reads this object
     * must not be able to miss it. */
    leftBlank: record.blocked ?? [],
    awaiting: draft.approval?.required
      ? 'your confirm code — nothing proceeds without it'
      : null,
    submitted: false,
  }
}

/* ---------------------------------------------------------------- storage */

function persist(record, filePath) {
  const store = load(filePath)

  /* Readings are the bulk and the least re-read part; verdicts carry the
   * capsule ids, so the trail survives the trim. */
  store.investigations.unshift({
    ...record,
    readings: (record.readings ?? []).map((reading) => ({
      inspector: reading.inspector,
      questionKey: reading.questionKey,
      answer: reading.answer,
      excerpt: reading.excerpt,
      capsuleId: reading.capsuleId,
      contentHash: reading.contentHash,
      sourceUrl: reading.sourceUrl,
      observedAt: reading.observedAt,
      error: reading.error,
    })),
  })
  store.investigations = store.investigations.slice(0, MAX_INVESTIGATIONS)
  save(store, filePath)
  return record
}

export function listInvestigations({ limit = 10 } = {}, { filePath = STORE_PATH } = {}) {
  return load(filePath).investigations.slice(0, Math.max(1, limit))
}

export function getInvestigation(investigationId, { filePath = STORE_PATH } = {}) {
  return (
    load(filePath).investigations.find((item) => item.investigationId === investigationId) ?? null
  )
}
