<script setup lang="ts">
import { computed, inject, Ref, ref } from "vue";
import { useGameData, useMapData } from "@src/store/game";
import MiniMap from "./mini-map.vue";
import PropertyInfoCard from "@src/views/game/utils/components/property-info-card.vue";

const selectedTargetIdList = inject<Ref<string[]>>("targetIdList", ref<string[]>([]));

const mapDataStore = useMapData();
const gameDataStore = useGameData();
const highLightMapItemIds = computed(() => {
	return mapDataStore.mapItems.filter((item) => item.property).map((item) => item.id);
});

const currentSelectedMapId = computed({
	get: () => {
		if (!selectedTargetIdList.value || !selectedTargetIdList.value.length) return "";

		const targetPropId = selectedTargetIdList.value[0];

		const mapItem = mapDataStore.mapItems.find((item) => item.property?.id === targetPropId);
		return mapItem ? mapItem.id : "";
	},

	set: (newMapItemId: string) => {
		const mapItem = mapDataStore.mapItems.find((i) => i.id === newMapItemId);
		if (mapItem && mapItem.property) {
			selectedTargetIdList.value = [mapItem.property.id];
		}
	},
});

const currentSelectedProperty = computed(() => {
	if (!selectedTargetIdList.value || !selectedTargetIdList.value.length) return null;
	const pid = selectedTargetIdList.value[0];
	return gameDataStore.properties.find((p) => p.id === pid);
});
</script>

<template>
	<div class="target-selector-container">
		<div class="target-container">
			<div class="tips">请在地图上选择目标地皮</div>

			<MiniMap :high-light-list="highLightMapItemIds" v-model:selected-id="currentSelectedMapId" />
		</div>

		<div class="preview-container">
			<div v-if="currentSelectedProperty" class="preview-content">
				<div class="preview-title">已选地皮详情</div>
				<PropertyInfoCard :property="currentSelectedProperty" />
			</div>

			<div v-else class="preview-placeholder">
				<div class="text">
					点击左侧
					<span class="highlight-text">高亮格子</span>
					查看详情
				</div>
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped>
.target-selector-container {
	display: flex;
	justify-content: space-between;
	align-items: flex-start;
	gap: 2rem;
	padding: 1rem;
	// 原本只有 min-height 没有上限：地皮详情卡很高（费用表 + 过路费网格 + 拥有者），
	// 会把整个弹窗顶高，确认按钮被挤到视口外，必须滚动才点得到。
	// 改成高度跟着视口收敛，超出的内容在各列内部滚动。
	min-height: min(28.125rem, 46vh);
	max-height: min(34rem, 62vh);

	.target-container {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		// flex 子项默认 min-height:auto，不显式给 0 的话撑不住 max-height，内部也滚不起来
		min-height: 0;
		max-height: 100%;
		overflow-y: auto;

		.tips {
			color: var(--fp-color-primary);
			text-align: center;
			margin-bottom: 1rem;
			font-size: 1.1rem;
		}
	}

	.preview-container {
		width: 20rem;
		flex: none;
		// 同上：给 0 才能被 max-height 约束住，详情卡再高也只在这一列里滚
		min-height: 0;
		max-height: 100%;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		border-left: 0.125rem dashed #e0e0e0;
		padding-left: 2rem;
		margin-top: 2.5rem;

		// 选中状态内容
		.preview-content {
			display: flex;
			flex-direction: column;
			align-items: center;
			animation: fade-in 0.3s ease-out;

			.preview-title {
				margin-bottom: 1rem;
				color: #666;
				font-size: 0.9rem;
			}
		}

		.preview-placeholder {
			flex: 1;
			display: flex;
			justify-content: center;
			align-items: center;
			color: #ccc;

			.text {
				text-align: center;
				line-height: 1.6;
				font-size: 1.1rem;

				.highlight-text {
					color: var(--fp-color-primary);
				}
			}
		}
	}
}

@keyframes fade-in {
	from {
		opacity: 0;
		transform: translateY(0.625rem);
	}
	to {
		opacity: 1;
		transform: translateY(0);
	}
}
</style>
