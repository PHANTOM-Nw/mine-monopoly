<script setup lang="ts">
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { __PROTOCOL__ } from "@src/../global.config";
import { computed, ref } from "vue";
import BuffItem from "./buff-item.vue";
import { PlayerInfo, PropertyInfo } from "@mine-monopoly/types";
import { useRoomInfo } from "@src/store";
import { useGameData } from "@src/store/game";
import UiRenderer from "@src/components/utils/ui-renderer/ui-renderer.vue";

const props = defineProps<{
	player: PlayerInfo;
}>();

const playersPropertyies = computed(() => {
	return useGameData().properties.filter((property) => {
		return property.owner && property.owner.userId === props.player.id;
	});
});

/** 展开中的地产 ID —— 简略信息常驻，详细数值按需展开 */
const expandedIds = ref<Set<string>>(new Set());
function toggleExpand(id: string) {
	const next = new Set(expandedIds.value);
	next.has(id) ? next.delete(id) : next.add(id);
	expandedIds.value = next;
}

/** 当前身价：地价 + 已投进去的建设费。和结算排名用的净资产口径一致 */
function propertyValue(p: PropertyInfo) {
	return p.sellCost + p.buildCost * p.level;
}

const avatarSrc = computed(() => {
	return props.player.user.avatar || "";
});

const chanceCardVisible = computed(() => {
	return useRoomInfo().gameSetting.chanceCardVisible;
});
</script>

<template>
	<div class="player-detail">
		<div class="info" v-if="player">
			<div class="user-properties">
				<div class="user">
					<div class="avatar">
						<img v-if="avatarSrc" :src="avatarSrc" />
						<FontAwesomeIcon v-else :style="{ color: player.user.color }" icon="gamepad" />
					</div>
					<div class="text" :style="{ color: player.user.color }">
						<UiRenderer :schema="player.infoDisplay" :context="{ player, exportData: useGameData().exportData }" />
					</div>
				</div>
				<div class="properyies-container">
					<div class="label">
						<FontAwesomeIcon icon="house" />
						地产 ({{ playersPropertyies.length }}处)
					</div>
					<div class="properyies-list">
						<div class="property-item" v-for="property in playersPropertyies" :key="property.id">
							<div class="summary" @click="toggleExpand(property.id)">
								<div class="name">{{ property.name }}</div>
								<div class="right">
									<span class="value">￥{{ propertyValue(property) }}</span>
									<span class="level" :class="{ max: property.level >= property.maxLevel }">
										LV {{ property.level }}/{{ property.maxLevel }}
									</span>
									<FontAwesomeIcon
										class="caret"
										:icon="expandedIds.has(property.id) ? 'angle-up' : 'angle-down'"
									/>
								</div>
							</div>

							<div class="detail" v-if="expandedIds.has(property.id)">
								<div class="row">
									<span>当前过路费</span>
									<b>￥{{ property.costList[property.level] ?? 0 }}</b>
								</div>
								<div class="row">
									<span>地价</span>
									<b>￥{{ property.sellCost }}</b>
								</div>
								<div class="row">
									<span>每级建设费</span>
									<b>￥{{ property.buildCost }}</b>
								</div>
								<div class="row" v-if="property.level < property.maxLevel">
									<span>升到 LV{{ property.level + 1 }} 后</span>
									<b>￥{{ property.costList[property.level + 1] ?? 0 }}</b>
								</div>
								<div class="toll-table">
									<div
										class="toll-cell"
										v-for="(toll, lv) in property.costList"
										:key="lv"
										:class="{ current: lv === property.level }"
									>
										<div class="lv">LV{{ lv }}</div>
										<div class="toll">{{ toll }}</div>
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>

			<div class="buff-container">
				<div class="label">
					<FontAwesomeIcon icon="book-tanakh" />
					BUFF (持续状态效果)
				</div>
				<div class="buff-list">
					<BuffItem :buff="buff" v-for="buff in player.buff" :key="buff.id" />
				</div>
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped>
@use "@src/assets/variables" as *;
@use "@mine-monopoly/style/variables" as fp;

.player-detail {
	width: 100%;
	height: 100%;
	padding: 1rem;
	display: flex;

	& > .info {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1.2rem;

		& > .user-properties {
			display: flex;
			align-self: stretch;
			align-items: center;
			justify-content: space-between;
			flex-direction: column;
			gap: 1.2rem;

			& > .user {
				@include felt-patch(#fff6d9);
				width: 100%;
				display: flex;
				align-items: center;
				justify-content: space-around;
				gap: 0.8rem;
				padding-left: 1.5rem;
				padding-right: 1.5rem;

				& > .text {
					flex: 1;
					display: flex;
					flex-direction: column;
					font-size: 1.3rem;
					text-align: center;
					border-radius: 1.4rem;
					margin: auto;
				}

				& > .avatar {
					$avatar_size: 5rem;

					color: #ffffff;
					width: $avatar_size;
					height: $avatar_size;
					font-size: 2.5rem;
					text-align: center;
					border-radius: 50%;
					border: 0.2rem solid #ffffff;
					overflow: hidden;
					box-shadow: var(--fp-shadow-md);
					position: relative;
					display: flex;
					justify-content: center;
					align-items: center;
					background-color: rgba(255, 255, 255, 0.75);

					& > img {
						width: $avatar_size;
						height: $avatar_size;
						object-fit: contain;
					}
				}
			}

			& > .properyies-container {
				@include felt-patch(#fff6d9);
				flex: 1;
				width: 20rem;
				display: flex;
				flex-direction: column;
				border-radius: 1.2rem;
				box-sizing: border-box;
				position: relative;

				& > .properyies-list {
					padding: 1.8rem 1rem;
					flex: 1;
					display: flex;
					flex-direction: column;
					align-items: center;
					overflow-y: auto;
					gap: 0.7rem;

					& > .property-item {
						width: 100%;
						display: flex;
						flex-direction: column;
						padding: 0.6rem 1.4rem;
						border-radius: 0.4rem;
						box-shadow: var(--fp-shadow-md);
						box-sizing: border-box;
						background-color: #ffffff;

						& > .summary {
							display: flex;
							justify-content: space-between;
							align-items: center;
							cursor: pointer;
							user-select: none;

							& > .right {
								display: flex;
								align-items: center;
								gap: 0.6rem;

								& > .value {
									font-size: 0.85em;
									color: var(--fp-color-text-secondary);
								}

								& > .caret {
									font-size: 0.8em;
									opacity: 0.5;
								}
							}
						}

						& > .detail {
							margin-top: 0.5rem;
							padding-top: 0.5rem;
							border-top: 0.0625rem dashed rgba(0, 0, 0, 0.12);
							font-size: 0.85em;

							& > .row {
								display: flex;
								justify-content: space-between;
								padding: 0.15rem 0;
								color: var(--fp-color-text-secondary);
							}

							& > .toll-table {
								display: flex;
								gap: 0.25rem;
								margin-top: 0.45rem;

								& > .toll-cell {
									flex: 1;
									text-align: center;
									padding: 0.25rem 0;
									border-radius: 0.25rem;
									background-color: rgba(0, 0, 0, 0.04);

									& > .lv {
										font-size: 0.75em;
										opacity: 0.6;
									}

									&.current {
										background-color: var(--fp-color-primary);
										color: #ffffff;

										& > .lv {
											opacity: 0.85;
										}
									}
								}
							}
						}

						& .name {
							color: var(--fp-color-secondary);
						}

						& > .level {
							color: var(--fp-color-primary);
						}
					}
				}
			}
		}

		& > .buff-container {
			@include felt-patch(#fff6d9);
			flex: 1;
			height: 100%;
			width: 100%;
			display: flex;
			flex-direction: column;
			border-radius: 1.2rem;
			box-sizing: border-box;

			& > .buff-list {
				padding: 1.2rem;
				padding-top: 2rem;
				flex: 1;
				display: flex;
				flex-direction: column;
				align-items: center;
				overflow-y: auto;
				gap: 0.7rem;
			}
		}
	}
}
.label {
	position: absolute;
	padding: 0.5rem 0.7rem;
	top: -0.8rem;
	left: 0.6rem;
	margin: 0;
	z-index: 1000;
	background-color: var(--fp-color-tertiary);
	background-image: var(--fp-texture-felt);
	border-radius: 0.5rem;
	color: #ffffff;
	box-shadow: var(--fp-shadow-depth);
}
</style>
