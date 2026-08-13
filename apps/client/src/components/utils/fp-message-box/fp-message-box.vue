<script setup lang="ts">
import { ref, VNode, isVNode, computed } from "vue";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import FpDialog from "../fp-dialog/fp-dialog.vue";
import { UISchema, FormSchema } from "@mine-monopoly/types";
import UiRenderer from "../ui-renderer/ui-renderer.vue";
import CustomForm from "../custom-form/index.vue";
import { useGameData } from "@src/store/game";
import { parseRichText } from "@mine-monopoly/utils";

export interface Props {
	title?: string;
	content?: string | VNode | (() => VNode) | UISchema;
	form?: FormSchema[];
	confirmText?: string;
	cancelText?: string;
	showCancel?: boolean;
	/** 这次弹窗由 AI 托管作答，本人只能看 */
	aiControlled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	title: "提示",
	confirmText: "确认",
	cancelText: "",
});

const emits = defineEmits<{
	confirm: [data?: any]; // 修改为支持传递数据
	cancel: [];
	close: [];
	takeover: [];
	resumeai: [];
}>();

const gameDataStore = useGameData();
// 托管期间弹窗只做展示：真正作答的是 AI。
// 跟着 isAI 走而不是只看初始值，玩家中途收回控制权时这个弹窗要就地变回可点的
const aiActing = computed(() => Boolean(props.aiControlled) && Boolean(gameDataStore.myGameInfo?.isAI));

// 解析富文本内容
const parsedContent = computed(() => {
	if (typeof props.content === "string") {
		return parseRichText(props.content);
	}
	return props.content;
});

const formData = ref<Record<string, any>>({}); // 存储表单数据

// 监听表单数据变化（由 UiRenderer 或 CustomForm 触发）
const handleFormChange = (data: Record<string, any>) => {
	formData.value = data;
};

const visible = ref(false);

const open = () => {
	visible.value = true;
};

defineExpose({ open });

const handleConfirm = () => {
	// 检查是否有表单数据
	// 优先检查 props.form，其次检查 props.content 是否为 UISchema
	const hasForm = props.form || (props.content && typeof props.content === "object" && "type" in props.content);
	const dataToSubmit = hasForm ? formData.value : undefined;

	emits("confirm", dataToSubmit);
	visible.value = false;
};

const handleCancel = () => {
	emits("cancel");
	visible.value = false;
};

const handleDialogClose = () => {
	emits("close");
};

const handleTakeOver = () => {
	emits("takeover");
};

const handleResumeAI = () => {
	emits("resumeai");
};
</script>

<template>
	<FpDialog
		v-model:visible="visible"
		:title="title"
		:hidden-footer="true"
		:append-to-body="true"
		:closable="!aiActing"
		style="min-width: 26rem; max-width: 90vw"
		@cancel="handleDialogClose"
	>
		<div class="message-content" :class="{ 'ai-locked': aiActing }">
			<!-- 渲染 content -->
			<component v-if="isVNode(parsedContent)" :is="parsedContent" />
			<div v-else-if="typeof parsedContent === 'string'" v-html="parsedContent"></div>
			<UiRenderer
				v-else-if="parsedContent && typeof parsedContent === 'object' && 'type' in parsedContent"
				:context="useGameData().$state"
				:schema="parsedContent as UISchema"
				@update:model-value="handleFormChange"
			/>

			<!-- 渲染 form（如果有） -->
			<CustomForm
				v-if="form"
				:schema="form"
				submit-text=""
				@update:model-value="handleFormChange"
			/>
		</div>

		<!-- 托管中：把 AI 正在处理的这件事原样摆出来，只是按钮换成收回控制权 -->
		<div v-if="aiActing" class="ai-footer">
			<span class="ai-hint">
				<FontAwesomeIcon class="ai-icon" icon="robot" />
				AI 托管中，正在替你决定…
			</span>
			<button class="btn-takeover" @click="handleTakeOver">收回控制权</button>
		</div>

		<div v-else class="message-footer">
			<!-- 刚从 AI 手里收回来的弹窗：留个口子，想接着托管就再交回去 -->
			<button v-if="aiControlled" class="btn-resume-ai" @click="handleResumeAI">交还给 AI</button>

			<button v-if="cancelText" class="btn-cancel" @click="handleCancel">
				{{ cancelText }}
			</button>

			<button class="btn-confirm" @click="handleConfirm">
				{{ confirmText }}
			</button>
		</div>
	</FpDialog>
</template>

<style lang="scss" scoped>
.message-content {
	font-size: 1rem;
	color: var(--fp-color-text-regular, #333);
	line-height: 1.5;

	// 使用 pre-wrap 保留换行符和空格
	// white-space: pre-wrap;

	// 直接针对 UiRenderer 的文本节点设置样式
	// 使用 :deep() 穿透到子组件，并使用 !important 确保优先级
	// :deep(.ui-text-node) {
	// 	white-space: pre-wrap !important;
	// }

	// 确保所有子元素也继承 white-space
	:deep(*) {
		white-space: inherit;
	}

	// 在表单前添加 margin
	:deep(.custom-form) {
		margin-top: 1rem;
	}

	// 托管期间内容只读：滚动交给外层的 .fp-dialog-body，这里只掐掉点击
	&.ai-locked {
		pointer-events: none;
	}
}

.ai-footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.75rem;
	margin-top: 0.9rem;
	padding-top: 0.7rem;
	border-top: 0.0625rem dashed var(--fp-color-border-light);

	.ai-hint {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--fp-color-text-secondary);
		font-size: 0.9rem;
	}

	.ai-icon {
		// 轻微呼吸，提示「现在不是你在打」
		animation: ai-thinking-pulse 1.6s ease-in-out infinite;
	}

	.btn-takeover {
		flex-shrink: 0;
		padding: 0.5em 1.2em;
		border: 0.0625rem solid var(--fp-color-tertiary);
		border-radius: 0.375rem;
		background-color: #ffffff;
		color: var(--fp-color-tertiary);
		font-size: 0.95rem;
		cursor: pointer;
		transition: filter 0.2s;

		&:hover {
			filter: brightness(0.95);
		}
	}
}

@keyframes ai-thinking-pulse {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.4;
	}
}

.message-footer {
	display: flex;
	justify-content: flex-end;
	gap: 0.75rem;
	margin-top: 0.625rem;

	.btn-resume-ai {
		margin-right: auto;
		border: 0.0625rem dashed var(--fp-color-border-light);
		background-color: transparent;
		color: var(--fp-color-text-secondary);
		font-size: 0.85rem;
	}

	button {
		padding: 0.5em 1.2em;
		border-radius: 0.375rem;
		font-size: 1rem;
		cursor: pointer;
		border: none;
		transition: filter 0.2s;

		&.btn-confirm {
			background-color: var(--fp-color-secondary);
			color: white;

			&:hover {
				filter: brightness(0.9);
			}
		}

		&.btn-cancel {
			border: 0.0625rem solid #b0b1b3;
			background-color: #ffffff;
			color: var(--fp-color-tertiary);
			border-color: var(--fp-color-tertiary);
			text-shadow: none;

			&:hover {
				filter: brightness(0.95);
			}
		}
	}
}
</style>
