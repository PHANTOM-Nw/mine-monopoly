import useEventBus from "@src/utils/event-bus";

/**
 * 服务端主动收掉某个弹窗时走这条总线。
 * 典型场景是 AI 托管：弹窗只是发给玩家看的镜像，AI 那边作答完就没人会去点它了。
 */
export const DIALOG_DISMISS_EVENT = "dialog:dismiss";

/**
 * 弹窗是被服务端收掉的，不是玩家点了取消。
 * 这种情况下不能再往回发操作结果，否则会把 AI 已经做完的决定覆盖成「取消」。
 */
export class DialogDismissedError extends Error {
	name = "DialogDismissedError";
	constructor(message: string = "Dialog dismissed by server") {
		super(message);
	}
}

export function emitDialogDismiss(dialogId: string): void {
	useEventBus().emit(DIALOG_DISMISS_EVENT, dialogId);
}

/**
 * 监听指定弹窗的关闭指令
 * @returns 取消监听的函数，弹窗销毁时记得调
 */
export function onDialogDismiss(dialogId: string | undefined, handler: () => void): () => void {
	if (!dialogId) return () => {};
	const listener = (id: string) => {
		if (id === dialogId) handler();
	};
	useEventBus().on(DIALOG_DISMISS_EVENT, listener);
	return () => useEventBus().remove(DIALOG_DISMISS_EVENT, listener);
}
