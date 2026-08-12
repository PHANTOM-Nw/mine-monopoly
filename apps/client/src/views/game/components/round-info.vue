<script setup lang="ts">
import { computed } from "vue";
import { useGameData } from "@src/store/game";

const gameInfoStore = useGameData();

// currentRound 由地图脚本在「整轮结束」阶段递增，语义是**已经打完的轮数**，
// 从 0 开始；同时它还被结束规则拿去和最大回合数比。
// 所以这里 +1 只改显示：开局第一轮就写「第 1 回合」，而不是「第 0 回合」。
const _currentRound = computed(() => gameInfoStore.currentRound + 1);
const _currentMultiplier = computed(() => gameInfoStore.currentMultiplier);
</script>

<template>
	<div class="round-info">
		<span class="round">第{{ _currentRound }}回合</span>
		<span class="multiplier">当前倍率：{{ _currentMultiplier }}倍</span>
	</div>
</template>

<style scoped lang="scss">
.round-info {
	color: var(--fp-color-text-white);
	background-color: var(--fp-color-secondary);
	text-shadow: var(--fp-text-shadow);
	display: flex;
	justify-content: space-around;
	align-items: center;
	padding: 0.4rem 1.2rem;
	border: 0.4rem solid rgba($color: #ffffff, $alpha: 0.5);
	border-top: 0;
	border-radius: 0 0 1rem 1rem;

	position: absolute;
	top: 0;
	left: 50%;
	transform: translateX(-50%);
	z-index: var(--z-ui);

	& > .round {
		font-size: 1.5rem;
		margin-right: 2rem;
	}

	& > .multiplier {
		font-size: 1rem;
	}
}
</style>
