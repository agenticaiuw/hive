# You scale

2026-08-07. The ambition, written down before the constraints, on purpose.

## The bottleneck

A person can be in one place, having one conversation, thinking one thought.
Everything else in a life — the admin, the follow-ups, the decisions that are
not really decisions — competes for that same single thread.

Every tool ever built makes the thread *faster*. Search, email, autocomplete,
chat assistants. None of them makes it **wider**. That is the ceiling, and
nothing currently shipping is aimed at it.

## Why this architecture and no other

Predicting what a person would decide requires knowing what they *did* decide,
in context, and what happened next. Nobody has that:

| holder | what it knows |
|---|---|
| a chat assistant | what you typed into a box |
| your calendar | where you were |
| your bank | what you bought |
| your employer | what you shipped |

A worn device that hears the day, a computer that watches the work, a browser
that holds the commitments, and a relay awake between them is the first thing
that sees **a whole life across every surface at once**. That is not a feature
advantage over the others. It is the only place the data can come from.

## The ambition

Not an assistant that helps. A model of the owner's judgment, accurate enough
to *act as them* across the enormous space of interactions that never needed
them personally.

- Year one: it drafts in their voice, and they edit.
- Year three: it answers the things they would have answered identically.
- Year ten: it negotiates, because it knows what they would accept and what
  they would walk away from.

The owner stops being the bottleneck in their own life. Attention becomes
something spent only where it is genuinely theirs to spend.

This is *Ancillary Justice* inverted. Not one mind in many bodies — **one
person in many bodies**.

## Why it compounds when nothing else does

Every product decays. The app gets worse, the company pivots, the user churns.
This gets better every day it is worn, and the switching cost is not lock-in —
it is that a decade of accumulated judgment does not transfer. A moat made of
time, which nobody can buy past.

## Three consequences worth naming now

**The mind runs partly outside the head.** Not memory — reasoning. Thinking
*through* it, continuously, the way one thinks through a notebook or through a
conversation with someone who already knows. The extended-mind thesis made
literal, and continuous rather than consulted.

**Presence.** People do not miss their children growing up because they do not
care. Attention is finite and the admin eats it. Give the admin away entirely
and what remains is the part that was always the point.

**Inheritance.** The model outlives the session, the device, the decade, and
potentially the owner. A person's judgment, preserved and still acting. That is
either the most valuable thing here or the most disquieting, and it should be
built deliberately by someone who has thought about it rather than discovered
by accident by someone who has not.

## What the graveyard actually says

Humane and Rabbit died selling a **gadget** — a worse phone, judged on its
first day. Nothing in that field was accumulating an asset, so there was
nothing to stay for; the reviews were the whole verdict.

The tell is what happened next. Meta bought Limitless and killed the hardware.
Amazon bought Bee and killed the hardware. HP bought Humane's software, patents
and staff and explicitly excluded the device business. **Every acquirer in the
category already believes the device is not the product.** They bought the data
and the team. None of them has built the thing that uses it.

The device is how the model gets its data. That is the whole role of the
hardware, and it is why the hardware being unglamorous is fine.

## What this does not excuse

Written down so the ambition does not quietly erase the findings in
`what-to-build.md`:

- Capture stays gated to the owner's own speech. That is a legal wall, not a
  product decision, and the model of one person does not need bystanders.
- The owner keeps the commit on anything that leaves their control. Dietvorst
  2018 says that gate is what makes people *use* an imperfect system, and it
  costs almost none of the value.
- Nothing here is worth building on a system that cannot say when it does not
  know. A model of someone's judgment that confabulates their judgment is worse
  than no model at all.
