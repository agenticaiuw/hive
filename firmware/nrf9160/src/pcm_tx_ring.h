#ifndef PCM_TX_RING_H_
#define PCM_TX_RING_H_

/*
 * SPSC byte-slot ring for live PCM upload. Capture produces fixed-size stages;
 * a time-budgeted network consumer drains them. Pure C for host unit tests.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

struct pcm_tx_ring {
	uint8_t *storage;
	size_t slot_bytes;
	size_t slot_count;
	size_t head; /* next write slot */
	size_t tail; /* next read slot */
	size_t count;
	uint32_t pushes;
	uint32_t pops;
	uint32_t overflows;
};

static inline void pcm_tx_ring_init(struct pcm_tx_ring *ring, uint8_t *storage,
				    size_t slot_bytes, size_t slot_count)
{
	ring->storage = storage;
	ring->slot_bytes = slot_bytes;
	ring->slot_count = slot_count;
	ring->head = 0U;
	ring->tail = 0U;
	ring->count = 0U;
	ring->pushes = 0U;
	ring->pops = 0U;
	ring->overflows = 0U;
}

static inline void pcm_tx_ring_reset(struct pcm_tx_ring *ring)
{
	ring->head = 0U;
	ring->tail = 0U;
	ring->count = 0U;
}

static inline bool pcm_tx_ring_empty(const struct pcm_tx_ring *ring)
{
	return ring->count == 0U;
}

static inline bool pcm_tx_ring_full(const struct pcm_tx_ring *ring)
{
	return ring->count >= ring->slot_count;
}

static inline size_t pcm_tx_ring_count(const struct pcm_tx_ring *ring)
{
	return ring->count;
}

/* Returns false if full (caller should abort live stream and fall back). */
static inline bool pcm_tx_ring_push(struct pcm_tx_ring *ring, const void *data,
				    size_t length)
{
	uint8_t *slot;

	if (length != ring->slot_bytes || pcm_tx_ring_full(ring)) {
		++ring->overflows;
		return false;
	}
	slot = ring->storage + ring->head * ring->slot_bytes;
	memcpy(slot, data, length);
	ring->head = (ring->head + 1U) % ring->slot_count;
	++ring->count;
	++ring->pushes;
	return true;
}

/* Peeks tail without pop. Returns NULL if empty. */
static inline const uint8_t *pcm_tx_ring_peek(const struct pcm_tx_ring *ring)
{
	if (pcm_tx_ring_empty(ring)) {
		return NULL;
	}
	return ring->storage + ring->tail * ring->slot_bytes;
}

static inline bool pcm_tx_ring_pop(struct pcm_tx_ring *ring)
{
	if (pcm_tx_ring_empty(ring)) {
		return false;
	}
	ring->tail = (ring->tail + 1U) % ring->slot_count;
	--ring->count;
	++ring->pops;
	return true;
}

#endif /* PCM_TX_RING_H_ */
