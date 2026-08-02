/* Zephyr I2S streaming version retained for later driver investigation. */
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2s.h>
#include <zephyr/kernel.h>

#define LED_NODE DT_ALIAS(led0)
#define I2S_NODE DT_NODELABEL(i2s0)

#define SAMPLE_RATE 16000U
#define CHANNEL_COUNT 2U
#define WORD_SIZE 16U
#define BLOCK_FRAMES 128U
#define BLOCK_COUNT 112U
#define BLOCK_SIZE (BLOCK_FRAMES * CHANNEL_COUNT * sizeof(int16_t))
#define TEST_AMPLITUDE 6000

static const struct gpio_dt_spec led =
	GPIO_DT_SPEC_GET(LED_NODE, gpios);

K_MEM_SLAB_DEFINE_STATIC(tx_slab, BLOCK_SIZE, BLOCK_COUNT, 4);

static const int16_t sine_table[32] = {
	0, 6393, 12540, 18205, 23170, 27245, 30273, 32138,
	32767, 32138, 30273, 27245, 23170, 18205, 12540, 6393,
	0, -6393, -12540, -18205, -23170, -27245, -30273, -32138,
	-32767, -32138, -30273, -27245, -23170, -18205, -12540, -6393,
};

volatile int speaker_test_result = -9999;
volatile uint8_t speaker_test_phase;

static int queue_segment(const struct device *i2s, uint16_t frequency_hz,
			 uint16_t duration_ms)
{
	const uint32_t total_frames =
		((uint32_t)duration_ms * SAMPLE_RATE) / 1000U;
	const uint32_t phase_step = frequency_hz == 0U
		? 0U
		: (uint32_t)(((uint64_t)frequency_hz << 32) / SAMPLE_RATE);
	const uint32_t fade_frames = SAMPLE_RATE / 200U;
	uint32_t phase = 0U;
	uint32_t frame_index = 0U;
	int error;

	while (frame_index < total_frames) {
		void *block;
		int16_t *samples;

		speaker_test_phase = 10;
		error = k_mem_slab_alloc(&tx_slab, &block, K_MSEC(1000));
		if (error != 0) {
			return error;
		}

		samples = block;
		for (uint32_t frame = 0U; frame < BLOCK_FRAMES; ++frame) {
			int16_t sample = 0;

			if (frame_index < total_frames && frequency_hz != 0U) {
				uint32_t gain = TEST_AMPLITUDE;
				uint32_t frames_left = total_frames - frame_index;

				if (frame_index < fade_frames) {
					gain = (gain * frame_index) / fade_frames;
				}
				if (frames_left < fade_frames) {
					gain = (gain * frames_left) / fade_frames;
				}

				sample = (int16_t)
					(((int32_t)sine_table[phase >> 27] *
					  (int32_t)gain) /
					 32767);
				phase += phase_step;
			}

			/* Identical L/R samples work with the amp's mono mix mode. */
			samples[2U * frame] = sample;
			samples[2U * frame + 1U] = sample;
			++frame_index;
		}

		speaker_test_phase = 11;
		error = i2s_write(i2s, block, BLOCK_SIZE);
		if (error != 0) {
			k_mem_slab_free(&tx_slab, block);
			return error;
		}

	}

	return 0;
}

static int play_test_chime(const struct device *i2s)
{
	struct i2s_config config = {
		.word_size = WORD_SIZE,
		.channels = CHANNEL_COUNT,
		.format = I2S_FMT_DATA_FORMAT_I2S,
		.options = I2S_OPT_FRAME_CLK_CONTROLLER |
			   I2S_OPT_BIT_CLK_CONTROLLER,
		.frame_clk_freq = SAMPLE_RATE,
		.mem_slab = &tx_slab,
		.block_size = BLOCK_SIZE,
		.timeout = 1000,
	};
	int error;

	speaker_test_phase = 1;
	error = i2s_configure(i2s, I2S_DIR_TX, &config);
	if (error != 0) {
		return error;
	}

	k_msleep(1500);
	gpio_pin_set_dt(&led, 1);
	speaker_test_phase = 2;

	/*
	 * Pre-queue this entire short chime before starting DMA. This makes
	 * the one-shot hardware test independent of producer-thread timing.
	 */
	error = queue_segment(i2s, 523U, 180U);
	if (error == 0) {
		error = queue_segment(i2s, 0U, 70U);
	}
	if (error == 0) {
		error = queue_segment(i2s, 659U, 180U);
	}
	if (error == 0) {
		error = queue_segment(i2s, 0U, 70U);
	}
	if (error == 0) {
		error = queue_segment(i2s, 784U, 350U);
	}
	if (error != 0) {
		(void)i2s_trigger(i2s, I2S_DIR_TX, I2S_TRIGGER_DROP);
		return error;
	}

	speaker_test_phase = 3;
	error = i2s_trigger(i2s, I2S_DIR_TX, I2S_TRIGGER_START);
	if (error != 0) {
		return error;
	}

	error = i2s_trigger(i2s, I2S_DIR_TX, I2S_TRIGGER_DRAIN);
	if (error != 0) {
		return error;
	}

	/* Keep PCLK32M active until the queued 0.9-second chime drains. */
	k_busy_wait(1000000);
	if (k_mem_slab_num_free_get(&tx_slab) != BLOCK_COUNT) {
		return -EAGAIN;
	}

	speaker_test_phase = 4;
	return 0;
}

int main(void)
{
	const struct device *const i2s = DEVICE_DT_GET(I2S_NODE);
	int error;

	if (!gpio_is_ready_dt(&led)) {
		speaker_test_result = -ENODEV;
		return 0;
	}

	error = gpio_pin_configure_dt(&led, GPIO_OUTPUT_INACTIVE);
	if (error != 0) {
		speaker_test_result = error;
		return 0;
	}

	if (!device_is_ready(i2s)) {
		speaker_test_result = -ENODEV;
		return 0;
	}

	speaker_test_result = play_test_chime(i2s);
	if (speaker_test_result == 0) {
		gpio_pin_set_dt(&led, 1);
		return 0;
	}

	while (true) {
		gpio_pin_toggle_dt(&led);
		k_msleep(150);
	}
}
