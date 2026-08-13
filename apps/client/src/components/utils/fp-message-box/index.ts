import { createVNode, render, type AppContext, type VNode, getCurrentInstance } from "vue";
import FPMessageBoxVue from "./fp-message-box.vue";
import useEventBus from "@src/utils/event-bus"; // 假设你还需要它
import { GameEventType, UISchema, FormSchema } from "@mine-monopoly/types"; // 假设你还需要它
import { onDialogDismiss, DialogDismissedError } from "../dialog-session";

/**
 * 用户取消操作时抛出的错误
 * 可通过 instanceof UserCancelledError 检测用户取消
 */
export class UserCancelledError extends Error {
	name = "UserCancelledError";
	constructor(message: string = "User cancelled") {
		super(message);
	}
}

/**
 * 超时操作时抛出的错误
 */
export class TimeoutError extends Error {
	name = "TimeoutError";
	constructor(message: string = "Timeout") {
		super(message);
	}
}

export interface MessageBoxOptions {
	title?: string;
	content?: string | VNode | (() => VNode) | UISchema;
	form?: FormSchema[];
	confirmText?: string;
	cancelText?: string;
	appContext?: AppContext;
	showCancel?: boolean;
	/** 弹窗会话 ID，服务端靠它把这个弹窗收掉 */
	dialogId?: string;
	/** 这次由 AI 托管作答，弹窗只做展示 */
	aiControlled?: boolean;
	/** 玩家在弹窗里点了「收回控制权」 */
	onTakeover?: () => void;
	/** 玩家在弹窗里点了「交还给 AI」 */
	onResumeai?: () => void;
	[key: string]: any;
}

export function FPMessageBox(options: MessageBoxOptions) {
	return new Promise<any>((resolve, reject) => {
		// 1. 创建一个容器（虚拟的挂载点）
		// 注意：因为 fp-dialog 内部使用了 <Teleport to="body">，
		// 所以这个 container 实际上只是用来承载 FPMessageBoxVue 实例的逻辑，
		// 它的 DOM 节点不会真正显示任何内容（内容被传送走了）。
		const container = document.createElement("div");

		// 2. 销毁逻辑
		let offDialogDismiss = () => {};
		const destroy = () => {
			useEventBus().remove(GameEventType.TimeOut, handleTimeout);
			offDialogDismiss();
			// 等待 Dialog 动画结束(约300ms)后再销毁，避免弹窗突然消失
			setTimeout(() => {
				render(null, container);
			}, 350);
		};

		// 服务端把这次弹窗收掉（例如托管中的 AI 已经替玩家作答）
		const handleDismiss = () => {
			reject(new DialogDismissedError());
			destroy();
		};

		const handleConfirm = (formData?: any) => {
			resolve(formData); // 修改为传递表单数据
			destroy();
		};

		const handleCancel = () => {
			reject(new UserCancelledError());
			destroy();
		};

		const handleTimeout = () => {
			// 这里的逻辑看你业务需求，通常超时算取消
			reject(new TimeoutError());
			// 如果超时，我们手动调用 close 逻辑吗？
			// 由于我们拿不到组件内部的 visible 状态，这里最好是销毁
			destroy();
		};

		// 3. 处理 VNode 内容 (支持函数式 content)
		let contentNode = options.content;
		if (typeof contentNode === "function") {
			contentNode = contentNode();
		}

		// 4. 创建 VNode
		const vnode = createVNode(FPMessageBoxVue, {
			...options,
			content: contentNode, // 确保传给组件的是结果
			onConfirm: handleConfirm,
			onCancel: handleCancel,
			onClose: handleCancel, // 遮罩点击或右上角关闭也视为取消
		});

		// 5. 继承上下文
		if (options.appContext) {
			vnode.appContext = options.appContext;
		} else {
			// 尝试自动获取当前上下文
			const current = getCurrentInstance();
			if (current) vnode.appContext = current.appContext;
		}

		// 6. 渲染
		render(vnode, container);

		// 7. 打开弹窗
		if (vnode.component && vnode.component.exposed) {
			(vnode.component.exposed as any).open();
		}

		// 8. 注册事件总线监听
		useEventBus().once(GameEventType.TimeOut, handleTimeout);
		offDialogDismiss = onDialogDismiss(options.dialogId, handleDismiss);
	});
}
