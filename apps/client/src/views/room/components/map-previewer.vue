<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { GameMapInDb } from "@mine-monopoly/types";
import { env } from "@mine-monopoly/env";

const { map } = defineProps<{ map: GameMapInDb }>();

const coverImageUrl = computed(() => {
	return map.coverUrl;
});
</script>

<template>
	<div class="map-preview">
		<div class="map-info">
			<div class="name-row" :class="{ 'is-official': map.isOfficial }">
				<div class="name">{{ map.name }}</div>
				<div v-if="map.isOfficial" class="official-badge" title="官方地图">官方</div>
				<div v-else class="workshop-badge" title="创意工坊">创意工坊</div>
			</div>
			<div class="bottom">
				<div class="version">版本: v{{ map.version }}</div>
				<span class="author-name" :class="{ 'is-official': map.isOfficial }">{{ map.author }}</span>
			</div>
		</div>
		<div class="map-cover-container">
			<img class="map-cover" :src="coverImageUrl" />
		</div>
	</div>
</template>

<style lang="scss" scoped>
.map-preview {
	width: 100%;
	height: 100%;
	border: 0.4rem solid #ffffff;
	border-radius: 1rem;
	box-sizing: border-box;
	overflow: hidden;
	position: relative;
}
.map-info {
	width: 100%;
	height: 100%;
	z-index: 100;
	position: absolute;
	display: flex;
	flex-direction: column;
	justify-content: space-between;
	padding: 0.2rem;
	box-sizing: border-box;

	& .name-row {
		display: flex;
		align-items: center;
		width: max-content;
		padding: 0.4rem 0.7rem;
		border-radius: 0.6rem;
		background-color: #4caf50;
		color: var(--fp-color-text-white);

		// 官方地图：与其他地图背景一致（默认主题色）
		&.is-official {
			background-color: var(--fp-color-secondary);
			box-shadow: none;
		}

		& .name {
			width: max-content;
			line-height: 1.2;
		}

		& .official-badge,
		& .workshop-badge {
			flex-shrink: 0;
			margin-left: 0.4rem;
			padding-left: 0.4rem;
			border-left: 0.0625rem solid rgba(255, 255, 255, 0.55);
			font-size: 0.7rem;
			line-height: 1.2;
			color: #fff;
		}
	}

	.bottom {
		display: flex;
		gap: 0.3rem;
		align-items: start;
		flex-direction: column;
	}

	& .version {
		width: max-content;
		padding: 0.2rem 0.3rem;
		border-radius: 0.4rem;
		font-size: 0.7rem;
		color: var(--fp-color-text-regular);
		background-color: var(--fp-color-bg-transparent);
	}

	& .author-name {
		width: max-content;
		padding: 0.2rem 0.4rem;
		border-radius: 0.3rem;
		background-color: #fff;
		color: #4caf50;
		font-size: 0.85rem;

		// 官方地图作者名：与官方地图名字背景（橙色）一致
		&.is-official {
			color: var(--fp-color-secondary);
		}
	}
}
.map-cover-container {
	width: 100%;
	height: 100%;
	display: flex;
	justify-content: center;
	align-items: center;
	background-color: #ddd;
	background-image: repeating-linear-gradient(
		45deg,
		#fffaf0 0,
		#fffaf0 0.8rem,
		#fff3d6 0.8rem,
		#fff3d6 1.6rem
	);
	padding: 0.5rem;
	box-sizing: border-box;
	position: absolute;
	left: 0;
	top: 0;

	.map-cover {
		display: block;
		width: auto;
		height: auto;
		object-fit: contain;
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
		margin: auto;
		border-radius: 0.6em;
	}
}
</style>
