#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "pcm_tx_ring.h"

#define SLOT 8
#define SLOTS 4

int main(void)
{
	uint8_t storage[SLOT * SLOTS];
	struct pcm_tx_ring ring;
	uint8_t a[SLOT];
	uint8_t b[SLOT];
	uint8_t c[SLOT];
	uint8_t d[SLOT];
	uint8_t e[SLOT];

	memset(a, 0x11, SLOT);
	memset(b, 0x22, SLOT);
	memset(c, 0x33, SLOT);
	memset(d, 0x44, SLOT);
	memset(e, 0x55, SLOT);

	pcm_tx_ring_init(&ring, storage, SLOT, SLOTS);
	assert(pcm_tx_ring_empty(&ring));
	assert(!pcm_tx_ring_full(&ring));

	assert(pcm_tx_ring_push(&ring, a, SLOT));
	assert(pcm_tx_ring_push(&ring, b, SLOT));
	assert(pcm_tx_ring_count(&ring) == 2);
	assert(memcmp(pcm_tx_ring_peek(&ring), a, SLOT) == 0);
	assert(pcm_tx_ring_pop(&ring));
	assert(memcmp(pcm_tx_ring_peek(&ring), b, SLOT) == 0);
	assert(pcm_tx_ring_pop(&ring));
	assert(pcm_tx_ring_empty(&ring));

	assert(pcm_tx_ring_push(&ring, a, SLOT));
	assert(pcm_tx_ring_push(&ring, b, SLOT));
	assert(pcm_tx_ring_push(&ring, c, SLOT));
	assert(pcm_tx_ring_push(&ring, d, SLOT));
	assert(pcm_tx_ring_full(&ring));
	assert(!pcm_tx_ring_push(&ring, e, SLOT));
	assert(ring.overflows == 1);

	/* Wrong size rejected */
	assert(!pcm_tx_ring_push(&ring, a, SLOT - 1U));

	assert(pcm_tx_ring_pop(&ring));
	assert(pcm_tx_ring_push(&ring, e, SLOT));
	assert(pcm_tx_ring_count(&ring) == 4);

	pcm_tx_ring_reset(&ring);
	assert(pcm_tx_ring_empty(&ring));
	assert(ring.pushes >= 5);

	puts("pcm_tx_ring_test: ok");
	return 0;
}
