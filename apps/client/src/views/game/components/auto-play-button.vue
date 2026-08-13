<template>
	<button
		v-if="visible"
		class="auto-play-button"
		:class="{ active: isAutoPlay }"
		:disabled="disabled"
		:title="tip"
		@click="handleToggle"
	>
		<FontAwesomeIcon class="icon" icon="robot" />
		<span class="label">{{ isAutoPlay ? "托管中" : "AI 托管" }}</span>
	</button>
</template>

<script setup lang="ts">
	import { computed, ref, watch } from "vue";
	import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
	import { useGameData } from "@src/store/game";
	import { useMonopolyClient } from "@src/core/monopoly-client/MonopolyClient";

	const props = defineProps<{ playerId: string }>();

	const gameDataStore = useGameData();

	const me = computed(() => gameDataStore.getPlayerInfoById(props.playerId));
	const isAutoPlay = computed(() => Boolean(me.value?.isAI));
	/** 只有真正坐在牌桌上的人才有这个开关：旁观者拿不到 PlayerInfo，出局的人也不需要 */
	const visible = computed(() => Boolean(me.value) && !me.value?.isBankrupted && !gameDataStore.isGameOver);

	// 状态以服务端广播的 isAI 为准，本地只压一个防抖，避免连点发出一串互相打架的开关
	const pending = ref(false);
	watch(isAutoPlay, () => {
		pending.value = false;
	});

	const disabled = computed(() => pending.value);
	const tip = computed(() =>
		isAutoPlay.value ? "收回控制权，改回自己操作" : "交给房主配置的 AI 替你行动，随时可以收回",
	);

	function handleToggle() {
		if (disabled.value) return;
		const client = useMonopolyClient();
		if (!client) return;
		pending.value = true;
		client.setAIControl(!isAutoPlay.value);
		// 广播万一没回来（掉线等），别把按钮永久卡在禁用态
		setTimeout(() => {
			pending.value = false;
		}, 3000);
	}
</script>

<style lang="scss" scoped>
	.auto-play-button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;

		width: 100%;
		padding: 0.4rem 0.6rem;
		border: 0.125rem solid var(--fp-color-border-light);
		border-radius: 0.8rem;
		background-color: var(--fp-color-bg-light);
		color: var(--fp-color-text-regular);

		font-size: 0.85rem;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color 0.2s ease,
			border-color 0.2s ease,
			color 0.2s ease;

		&:hover:not(:disabled) {
			border-color: var(--fp-color-primary);
			color: var(--fp-color-primary);
		}

		&:disabled {
			cursor: not-allowed;
			opacity: 0.6;
		}

		&.active {
			border-color: var(--fp-color-border-warning);
			background-color: var(--fp-color-bg-warning);
			color: var(--fp-color-text-warning);

			.icon {
				// 托管中给个轻微的呼吸，提醒「现在不是你在打」
				animation: auto-play-pulse 1.6s ease-in-out infinite;
			}
		}
	}

	.icon {
		font-size: 0.95em;
	}

	@keyframes auto-play-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.45;
		}
	}
</style>
