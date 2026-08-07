import {
	app,
	ipcMain,
	BrowserWindow,
	Menu,
	dialog,
	OpenDialogOptions,
	SaveDialogOptions,
	protocol,
	net,
	shell,
} from "electron";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "fs/promises";
import fsSync from "fs";
import url from "node:url";
import { autoUpdater } from "electron-updater";
import log from "electron-log";
import { loadUpdateSources, type UpdateSource } from "./update-config.js";
import { GMAction, GMActionResponseData } from "../src/interfaces/worker";

// ============================================================
// 更新源配置
// ============================================================
let currentUpdateSource: UpdateSource | null = null;
let isFallbackInProgress = false;

// --------- 错误日志处理 ---------

interface LogErrorData {
	type: "Vue" | "Promise" | "Runtime" | "Worker" | "Network" | "Console";
	message: string;
	stack?: string;
	info?: string;
	filename?: string;
	lineno?: number;
	colno?: number;
	url?: string;
	method?: string;
	status?: number;
	timestamp?: string;
	additionalData?: Record<string, any>;
}

// 日志目录：在用户数据目录下（跨平台可写，兼容 macOS .app 包结构）
const logsDir = path.join(app.getPath("userData"), "logs");

// 增强的日志文件路径
const mainLogPath = path.join(logsDir, "main.log");
const errorLogPath = path.join(logsDir, "error.log");

// 日志文件健康检查
let logFileHealthy = true;
let lastLogCheck = 0;
const LOG_CHECK_INTERVAL = 60000; // 每分钟检查一次

// 本地时间格式化（YYYY-MM-DD HH:mm:ss）
function formatLocalTime(date: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// 检查日志文件是否可写
async function checkLogFileHealth(): Promise<boolean> {
	const now = Date.now();
	if (now - lastLogCheck < LOG_CHECK_INTERVAL) {
		return logFileHealthy;
	}
	lastLogCheck = now;

	try {
		const testPath = path.join(logsDir, ".health-check");
		await fs.appendFile(testPath, `health-check-${now}\n`);
		await fs.unlink(testPath);
		logFileHealthy = true;
		return true;
	} catch (err) {
		logFileHealthy = false;
		console.error("[日志健康检查失败]:", err);
		// 尝试重新创建日志目录
		try {
			await fs.mkdir(logsDir, { recursive: true });
			logFileHealthy = true;
		} catch (retryErr) {
			console.error("[重建日志目录失败]:", retryErr);
		}
		return false;
	}
}

// 确保日志目录存在
async function ensureLogsDir() {
	try {
		await fs.mkdir(logsDir, { recursive: true });

		// 初始化日志文件
		const now = formatLocalTime();
		const header = `\n${"=".repeat(80)}\n应用启动: ${now}\nElectron 版本: ${process.versions.electron}\nChrome 版本: ${process.versions.chrome}\nNode 版本: ${process.versions.node}\n平台: ${process.platform}\n架构: ${process.arch}\n${"=".repeat(80)}\n\n`;

		await fs.appendFile(mainLogPath, header, "utf-8");
		await fs.appendFile(errorLogPath, header, "utf-8");
	} catch (err) {
		console.error("Failed to create logs directory:", err);
	}
}

// 格式化日志条目（增强版）
function formatLogEntry(error: LogErrorData): string {
	const timestamp = formatLocalTime();

	let log = `\n[${timestamp}] [${error.type}]\n`;
	log += `消息: ${error.message}\n`;

	if (error.info) {
		log += `信息: ${error.info}\n`;
	}

	if (error.filename) {
		log += `文件: ${error.filename}:${error.lineno}:${error.colno}\n`;
	}

	if (error.url) {
		log += `URL: ${error.url}\n`;
		if (error.method) {
			log += `方法: ${error.method}\n`;
		}
		if (error.status) {
			log += `状态码: ${error.status}\n`;
		}
	}

	if (error.stack) {
		// 改进堆栈格式化
		log += `\n堆栈跟踪:\n`;
		const lines = error.stack.split("\n");
		for (const line of lines) {
			log += `  ${line}\n`;
		}
	}

	if (error.additionalData) {
		log += `\n附加数据:\n`;
		try {
			log += `  ${JSON.stringify(error.additionalData, null, 2)}\n`;
		} catch (err) {
			log += `  [无法序列化附加数据]\n`;
		}
	}

	log += "-".repeat(80) + "\n";
	return log;
}

// 同时写入主日志和错误日志
async function writeLogEntry(logEntry: string, isError: boolean = true): Promise<void> {
	const healthOk = await checkLogFileHealth();
	if (!healthOk) {
		console.error("[日志系统异常] 无法写入日志文件");
		return;
	}

	try {
		// 所有错误都写入主日志
		await fs.appendFile(mainLogPath, logEntry, "utf-8");
		// 错误也写入专门的错误日志
		if (isError) {
			await fs.appendFile(errorLogPath, logEntry, "utf-8");
		}
	} catch (err) {
		console.error("[写入日志失败]:", err);
		logFileHealthy = false;
	}
}

// 写入错误日志（增强版）
async function writeErrorLog(error: LogErrorData): Promise<string | null> {
	const logEntry = formatLogEntry(error);

	// 确定错误等级
	const isError = ["Vue", "Promise", "Runtime", "Worker"].includes(error.type);

	await writeLogEntry(logEntry, isError);

	// 返回日志文件路径用于显示
	return isError ? errorLogPath : mainLogPath;
}

autoUpdater.logger = log;
autoUpdater.autoDownload = false; // 关键：设为 false，防止游戏过程中自动抢网速
autoUpdater.autoInstallOnAppQuit = true; // 退出时自动安装

log.transports.file.level = "info";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = path.join(__dirname, "..");

export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

const isProduction = app.isPackaged;

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, "public") : RENDERER_DIST;

let win: BrowserWindow | null;

function buildAppMenu() {
	if (process.platform !== "darwin") return;

	const template: Electron.MenuItemConstructorOptions[] = [
		{
			label: app.name,
			submenu: [
				{ role: "about" as any },
				{ type: "separator" },
				{ role: "services" as any, submenu: [] },
				{ type: "separator" },
				{ role: "hide" as any },
				{ role: "hideOthers" as any },
				{ role: "unhide" as any },
				{ type: "separator" },
				{ role: "quit" as any },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" as any },
				{ role: "redo" as any },
				{ type: "separator" },
				{ role: "cut" as any },
				{ role: "copy" as any },
				{ role: "paste" as any },
				{ role: "selectAll" as any },
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "toggleDevTools" as any },
				{ type: "separator" },
				{ role: "resetZoom" as any },
				{ role: "zoomIn" as any },
				{ role: "zoomOut" as any },
				{ type: "separator" },
				{ role: "togglefullscreen" as any },
			],
		},
		{
			label: "Window",
			submenu: [{ role: "minimize" as any }, { role: "zoom" as any }, { role: "close" as any }],
		},
	];

	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}

function createWindow() {
	win = new BrowserWindow({
		width: 1200,
		height: 780,
		minWidth: 1200,
		minHeight: 780,
		webPreferences: {
			nodeIntegration: true,
			nodeIntegrationInWorker: false,
			contextIsolation: true,
			sandbox: false,
			enableBlinkFeatures: "WebRTC",
			preload: path.join(__dirname, "preload.mjs"),
			devTools: isProduction ? false : true,
			webSecurity: false,
			// 允许自动播放音频，无需用户交互
			autoplayPolicy: "no-user-gesture-required",
		},
		frame: false,
		...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
	});

	if (!isProduction) win.webContents.openDevTools();

	win.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: "deny" };
	});

	win.webContents.on("did-finish-load", () => {
		win?.webContents.send("main-process-message", new Date().toLocaleString());
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL);
	} else {
		// win.loadFile("./dist/index.html");
		win.loadFile(path.join(RENDERER_DIST, "frontend/index.html")).catch((err) => {
			console.error("[加载页面失败]:", err);
			writeLogEntry(`[${formatLocalTime()}] [FATAL] 加载页面失败: ${err.message}\n`, true);
		});
	}

	win.on("enter-full-screen", () => {
		win!.webContents.send("fullscreen-changed", true);
	});

	win.on("leave-full-screen", () => {
		win!.webContents.send("fullscreen-changed", false);
	});

	autoUpdater.on("update-available", (info) => {
		win && win.webContents.send("update-status", {
			status: "available",
			info,
			sourceName: currentUpdateSource?.name,
		});
	});

	// 已经是最新
	autoUpdater.on("update-not-available", (info) => {
		win && win.webContents.send("update-status", {
			status: "not-available",
			info,
			sourceName: currentUpdateSource?.name,
		});
	});

	// 下载进度
	autoUpdater.on("download-progress", (progressObj) => {
		win && win.webContents.send("update-status", { status: "progress", progress: progressObj });
	});

	// 下载完成
	autoUpdater.on("update-downloaded", (info) => {
		win && win.webContents.send("update-status", { status: "downloaded", info });
	});

	// 错误 — fallback 期间的错误静默处理，由 checkForUpdatesWithFallback 循环接管
	autoUpdater.on("error", (err) => {
		if (isFallbackInProgress) return;
		win && win.webContents.send("update-status", { status: "error", error: err.message });
	});
}

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
		win = null;
	}
});

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) {
		createWindow();
	}
});

// ===== 游戏进程控制台 (dev only) =====
let inspectorWin: BrowserWindow | null = null;
let aiConsoleWin: BrowserWindow | null = null;

async function executeInMainWindow<T>(script: string): Promise<T> {
	if (!win || win.isDestroyed()) {
		throw new Error("Main window not available");
	}
	return await win.webContents.executeJavaScript(script);
}

async function executeAIControlBridge<T>(callExpression: string, missingResult: string): Promise<T> {
	return await executeInMainWindow(
		"(async function() {" +
			"  const bridge = window.__aiControlBridge;" +
			"  if (!bridge) {" +
			`    return ${missingResult};` +
			"  }" +
			`  return await ${callExpression};` +
			"})()",
	);
}

ipcMain.handle("open-inspector", async () => {
	if (app.isPackaged) return;
	if (inspectorWin && !inspectorWin.isDestroyed()) {
		inspectorWin.focus();
		return;
	}

	inspectorWin = new BrowserWindow({
		width: 900,
		height: 700,
		title: "游戏进程控制台",
		frame: false,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
		},
	});

	inspectorWin.loadFile(path.join(process.env.APP_ROOT!, "electron", "inspector.html"));
	inspectorWin.on("closed", () => {
		inspectorWin = null;
	});

	// Handle close button from inspector window
	ipcMain.on("close-inspector", () => {
		if (inspectorWin && !inspectorWin.isDestroyed()) {
			inspectorWin.close();
		}
	});
});

ipcMain.handle("open-ai-console", async () => {
	if (aiConsoleWin && !aiConsoleWin.isDestroyed()) {
		aiConsoleWin.focus();
		return;
	}

	aiConsoleWin = new BrowserWindow({
		width: 1360,
		height: 820,
		minWidth: 1040,
		minHeight: 700,
		title: "AI 控制台",
		frame: false,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
		},
	});

	aiConsoleWin.loadFile(path.join(process.env.APP_ROOT!, "electron", "ai-console.html"));
	aiConsoleWin.on("closed", () => {
		aiConsoleWin = null;
	});
});

ipcMain.on("close-ai-console", () => {
	if (aiConsoleWin && !aiConsoleWin.isDestroyed()) {
		aiConsoleWin.close();
	}
});

ipcMain.handle("inspector:get-state", async () => {
	try {
		const result = await executeInMainWindow(
			"(function() {" +
				"  const bridge = window.__gpBridge;" +
				"  if (!bridge || typeof bridge.requestState !== 'function') {" +
				"    return { __error: 'GameProcess not started yet' };" +
				"  }" +
				"  return new Promise((resolve) => {" +
				"    const timeout = setTimeout(() => {" +
				"      bridge.onState = null;" +
				"      resolve({ __error: 'Timeout: Worker did not respond' });" +
				"    }, 3000);" +
				"    bridge.onState = (state) => {" +
				"      clearTimeout(timeout);" +
				"      bridge.onState = null;" +
				"      resolve(state);" +
				"    };" +
				"    bridge.requestState();" +
				"  });" +
				"})()",
		);
		return result;
	} catch (e: any) {
		return { __error: e.message };
	}
});

ipcMain.handle("inspector:gm-action", async (event, action: GMAction) => {
	try {
		const result = await executeInMainWindow(
			"(function() {" +
				"  const room = window.__roomInstance;" +
				"  if (!room || typeof room.gmAction !== 'function') {" +
				"    return { success: false, error: 'Room not available or gmAction not supported' };" +
				"  }" +
				"  return new Promise((resolve) => {" +
				"    room.gmAction(" + JSON.stringify(action) + ").then(resolve);" +
				"  });" +
				"})()"
		);
		return result;
	} catch (e: any) {
		return { success: false, error: e.message };
	}
});

ipcMain.handle("ai-console:get-state", async () => {
	try {
		return await executeAIControlBridge(
			"bridge.getSnapshot()",
			"{ __error: 'AI control bridge not available' }",
		);
	} catch (e: any) {
		return { __error: e.message };
	}
});

ipcMain.handle("ai-console:apply-config", async (_event, config) => {
	try {
		return await executeAIControlBridge(
			"bridge.applyConfig(" + JSON.stringify(config) + ")",
			"{ success: false, error: 'AI control bridge not available' }",
		);
	} catch (e: any) {
		return { success: false, error: e.message };
	}
});

ipcMain.handle("ai-console:set-player-binding", async (_event, payload: { userId: string; binding: unknown }) => {
	try {
		return await executeAIControlBridge(
			"bridge.setPlayerBinding(" +
				JSON.stringify(payload?.userId) +
				", " +
				JSON.stringify(payload?.binding ?? {}) +
				")",
			"{ success: false, error: 'AI control bridge not available' }",
		);
	} catch (e: any) {
		return { success: false, error: e.message };
	}
});

ipcMain.handle("ai-console:clear-usage", async () => {
	try {
		return await executeAIControlBridge(
			"bridge.clearUsage()",
			"{ success: false, error: 'AI control bridge not available' }",
		);
	} catch (e: any) {
		return { success: false, error: e.message };
	}
});

ipcMain.handle("ai-console:clear-memory", async (_event, payload: { playerId?: string } | undefined) => {
	try {
		const playerId = payload?.playerId ?? null;
		return await executeAIControlBridge(
			"bridge.clearMemory(" + JSON.stringify(playerId) + " || undefined)",
			"{ success: false, error: 'AI control bridge not available' }",
		);
	} catch (e: any) {
		return { success: false, error: e.message };
	}
});
// ===== End 游戏进程控制台 =====

app.whenReady().then(async () => {
	protocol.handle("local", (request) => {
		const filePath = request.url.slice("local://".length);
		return net.fetch(url.pathToFileURL(path.join(__dirname, filePath)).toString());
	});

	try {
		await ensureLogsDir();
		buildAppMenu();
		createWindow();
	} catch (err: any) {
		console.error("[应用初始化失败]:", err);
		await writeLogEntry(`[${formatLocalTime()}] [FATAL] 应用初始化失败: ${err.message}\n${err.stack || ""}\n`, true);
		throw err;
	}
});

ipcMain.on("window-minimize", () => {
	if (win) win.minimize();
});

ipcMain.on("window-maximize", () => {
	if (win) {
		if (win.isMaximized()) {
			win.unmaximize();
		} else {
			win.maximize();
		}
	}
});

ipcMain.on("window-close", () => {
	if (win) win.close();
});

ipcMain.handle("window-is-maximized", () => {
	return win ? win.isMaximized() : false;
});

ipcMain.handle("open-external", async (_event, targetUrl: string) => {
	await shell.openExternal(targetUrl);
});

const cacheDir = path.join(app.getPath("userData"), "map-cache");
const indexFile = path.join(cacheDir, "index.json");
/** 默认最大缓存容量 500MB */
const DEFAULT_MAX_CACHE_SIZE = 500 * 1024 * 1024;

/** index.json 条目：hash + 最后使用时间戳（用于 LRU 淘汰） */
interface CacheIndexEntry {
	hash: string;
	lastUsed: number;
}
type CacheIndex = Record<string, CacheIndexEntry>;

/**
 * 缓存键（mapId / hash）白名单校验：仅允许字母数字与 -_，且拒绝原型链危险键。
 * 防止通过 IPC 传入的 mapId/hash 拼入文件路径造成目录逃逸或原型污染。
 */
function isValidCacheKey(key: string): boolean {
	return /^[A-Za-z0-9_-]{1,128}$/.test(key) && key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

async function loadIndex(): Promise<CacheIndex> {
	try {
		const raw = await fs.readFile(indexFile, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, string | CacheIndexEntry>;
		// 兼容旧格式：{ mapId: hash }（无 lastUsed），迁移为条目结构。
		// 使用无原型对象组装，杜绝 "__proto__" 等键触发原型污染。
		const index: CacheIndex = Object.create(null) as CacheIndex;
		for (const [mapId, value] of Object.entries(parsed)) {
			if (!isValidCacheKey(mapId)) continue;
			if (typeof value === "string") {
				if (isValidCacheKey(value)) index[mapId] = { hash: value, lastUsed: 0 };
			} else if (value && typeof value === "object" && typeof value.hash === "string" && isValidCacheKey(value.hash)) {
				index[mapId] = {
					hash: value.hash,
					lastUsed: typeof value.lastUsed === "number" ? value.lastUsed : 0,
				};
			}
		}
		return index;
	} catch {
		return Object.create(null) as CacheIndex;
	}
}

async function saveIndex(index: CacheIndex) {
	await fs.writeFile(indexFile, JSON.stringify(index, null, 2), "utf-8");
}

/** 统计缓存目录中 .bin 文件的总大小与数量 */
async function getCacheSize(): Promise<{ size: number; count: number }> {
	let size = 0;
	let count = 0;
	try {
		const entries = await fs.readdir(cacheDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".bin")) continue;
			const stat = await fs.stat(path.join(cacheDir, entry.name)).catch(() => null);
			if (stat) {
				size += stat.size;
				count += 1;
			}
		}
	} catch {
		// 目录不存在视为空缓存
	}
	return { size, count };
}

/** LRU 淘汰：按 lastUsed 升序删除缓存项，直到总大小低于 maxSizeBytes */
async function enforceCacheLimit(index: CacheIndex, maxSizeBytes: number) {
	const { size } = await getCacheSize();
	if (size <= maxSizeBytes) return;

	// lastUsed 为 0 的旧格式条目优先淘汰
	const entries = Object.entries(index).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
	for (const [mapId, entry] of entries) {
		const filePath = path.join(cacheDir, `${mapId}-${entry.hash}.bin`);
		await fs.rm(filePath, { force: true }).catch(() => {});
		delete index[mapId];
		const { size: currentSize } = await getCacheSize();
		if (currentSize <= maxSizeBytes) break;
	}
	await saveIndex(index);
}

ipcMain.handle("map-cache:save", async (_event, mapId: string, hash: string, buffer: ArrayBuffer, maxSizeBytes?: number) => {
	// hash 为空无法校验版本，不缓存（避免不同版本地图串用）；同时白名单校验防路径逃逸
	if (!isValidCacheKey(mapId) || !isValidCacheKey(hash)) return;

	// 容量上限钳制：非法值（NaN/Infinity/<=0）回退默认 500MB，超 10GB 硬顶
	const MAX_CACHE_LIMIT = 10240 * 1024 * 1024; // 与设置面板上限一致（10GB）
	const limit =
		Number.isFinite(maxSizeBytes) && maxSizeBytes! > 0
			? Math.min(maxSizeBytes!, MAX_CACHE_LIMIT)
			: DEFAULT_MAX_CACHE_SIZE;
	// 单文件超过容量上限则缓存无意义，直接拒绝（防止一次写入撑爆磁盘）
	if (!buffer || buffer.byteLength <= 0 || buffer.byteLength > limit) return;

	async function ensureCacheDir() {
		await fs.mkdir(cacheDir, { recursive: true });
	}

	await ensureCacheDir();
	const index = await loadIndex();
	const oldEntry = index[mapId];

	// 删除旧文件
	if (oldEntry && oldEntry.hash !== hash) {
		const oldFilePath = path.join(cacheDir, `${mapId}-${oldEntry.hash}.bin`);
		await fs.rm(oldFilePath, { force: true }).catch(() => {});
	}

	const filePath = path.join(cacheDir, `${mapId}-${hash}.bin`);
	await fs.writeFile(filePath, new Uint8Array(buffer));

	index[mapId] = { hash, lastUsed: Date.now() };
	await saveIndex(index);

	// 容量管理（未传时使用默认 500MB）
	await enforceCacheLimit(index, limit);
});

ipcMain.handle("map-cache:load", async (_event, mapId: string, hash: string) => {
	if (!isValidCacheKey(mapId) || !isValidCacheKey(hash)) return undefined;
	const index = await loadIndex();
	const entry = index[mapId];
	if (!entry || entry.hash !== hash) return undefined;

	const filePath = path.join(cacheDir, `${mapId}-${hash}.bin`);
	try {
		const buf = await fs.readFile(filePath);
		// 命中时刷新最后使用时间（LRU 依据）
		entry.lastUsed = Date.now();
		await saveIndex(index);
		// 返回精确大小的 ArrayBuffer，避免底层大 Buffer 内存一并传出
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	} catch {
		return undefined;
	}
});

/** 当前缓存占用统计（大小字节 + 文件数） */
ipcMain.handle("map-cache:stat", async () => {
	return getCacheSize();
});

/** 清空缓存目录并重置索引 */
ipcMain.handle("map-cache:clear", async () => {
	await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
	await fs.mkdir(cacheDir, { recursive: true });
	await saveIndex({});
	return getCacheSize();
});

/** 打开缓存文件夹（资源管理器中显示） */
ipcMain.handle("map-cache:open-folder", async () => {
	await fs.mkdir(cacheDir, { recursive: true });
	await shell.openPath(cacheDir);
	return cacheDir;
});

// ============================================================
// 多源自动 fallback 更新检查
// ============================================================
async function checkForUpdatesWithFallback() {
	const sources = loadUpdateSources(app.getPath("userData"));
	if (sources.length === 0) {
		win?.webContents.send("update-status", {
			status: "error",
			error: "没有可用的更新源，请联系客服",
		});
		return;
	}

	isFallbackInProgress = true;

	let lastError: string | null = null;

	for (const source of sources) {
		try {
			log.info(`[Updater] 尝试源: "${source.name}" (${source.url})`);
			autoUpdater.setFeedURL(source.url);
			currentUpdateSource = source;

			const result = await autoUpdater.checkForUpdates();

			// 成功：update-available 或 update-not-available 事件已在上面处理
			isFallbackInProgress = false;
			return result;
		} catch (err: any) {
			log.info(`[Updater] 源 "${source.name}" 失败: ${err.message}`);
			lastError = err.message;
			// 继续尝试下一个源
		}
	}

	isFallbackInProgress = false;
	currentUpdateSource = null;

	// 所有源均失败
	win?.webContents.send("update-status", {
		status: "error",
		error: `所有更新源均不可用（共 ${sources.length} 个）\n${lastError || "未知错误"}`,
		sourceName: "无",
	});
}

// A. 检查更新（可以由前端触发，也可以启动时触发）
ipcMain.handle("check-for-update", () => {
	if (!app.isPackaged) return "dev-mode"; // 开发环境不检查
	return checkForUpdatesWithFallback();
});

// B. 开始下载
ipcMain.handle("start-download-update", () => {
	autoUpdater.downloadUpdate();
});

// C. 退出并安装
ipcMain.handle("quit-and-install", () => {
	autoUpdater.quitAndInstall();
});

// --- 错误日志 IPC 处理 ---
ipcMain.on("log-error", (_event, error: LogErrorData) => {
	writeErrorLog(error);
});

// 主进程未捕获异常
process.on("uncaughtException", async (err) => {
	console.error("[主进程未捕获异常]:", err);

	await writeErrorLog({
		type: "Runtime",
		message: err.message,
		stack: err.stack,
		additionalData: {
			process: "main",
			uncaught: true,
		},
	});
});

// 主进程未处理的 Promise 拒绝
process.on("unhandledRejection", async (reason) => {
	console.error("[主进程未处理的 Promise 拒绝]:", reason);

	const errMessage = reason instanceof Error ? reason.message : String(reason);

	await writeErrorLog({
		type: "Promise",
		message: errMessage,
		stack: reason instanceof Error ? reason.stack : undefined,
		additionalData: {
			process: "main",
			unhandledRejection: true,
		},
	});
});

// 记录控制台输出到文件
ipcMain.on("log-console", async (_event, data: { level: string; message: string; stack?: string }) => {
	const timestamp = formatLocalTime();
	const logEntry = `[${timestamp}] [Console.${data.level}] ${data.message}\n`;

	if (data.stack) {
		const lines = data.stack.split("\n");
		for (const line of lines) {
			await writeLogEntry(`  ${line}\n`, false);
		}
	}
});

// 记录网络请求错误
ipcMain.on("log-network", async (_event, data: { url: string; method: string; status?: number; error: string }) => {
	await writeErrorLog({
		type: "Network",
		message: data.error,
		url: data.url,
		method: data.method,
		status: data.status,
		additionalData: {
			process: "renderer",
		},
	});
});

// 打开日志文件夹
ipcMain.handle("open-logs-folder", async () => {
	await shell.openPath(logsDir);
	return logsDir;
});
