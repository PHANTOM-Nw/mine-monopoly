/**
 * 游客身份的持久化。
 *
 * 游客没有账号、没有 JWT，身份就是一串本地生成的 userId —— 这串东西丢了，
 * 房主就认不出重连回来的是谁（`Room.isUserInRoom` 只比对 userId）。
 * 所以在 localStorage 之外再写一份 cookie，任一份还在就能恢复。
 *
 * 两点边界，别指望它做到做不到的事：
 * 1. Electron 生产版是 `win.loadFile(...)`，页面 origin 是 file://，
 *    Chromium 在 file:// 下禁止读写 document.cookie。桌面端这份 cookie 写不进去，
 *    这里会自动降级成只用 localStorage。Web 版和 Capacitor（http origin）正常。
 * 2. cookie 不会让重连更安全。房主是另一台浏览器里的对等端，读不到你的 cookie；
 *    非 HttpOnly 的 cookie 和 localStorage 一样是同源可读可改的。要防冒名顶替
 *    得由房主签发一次性凭证，跟存在哪儿无关。
 */

const STORAGE_KEY = "user";
const COOKIE_KEY = "mm_guest";
/** 一年。游客身份没有有效期概念，够长就行 */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
/** 单条 cookie 通常限 4KB，留出余量；超了就只写 localStorage */
const COOKIE_MAX_BYTES = 3072;

export interface GuestIdentity {
	userId: string;
	useraccount: string;
	username: string;
	avatar: string;
	color: string;
}

/** file:// 下 document.cookie 读写都会被静默丢弃，先探一次免得白写 */
function isCookieUsable(): boolean {
	try {
		if (typeof document === "undefined") return false;
		return window.location.protocol !== "file:";
	} catch {
		return false;
	}
}

function readCookie(name: string): string | null {
	if (!isCookieUsable()) return null;
	try {
		const prefix = `${name}=`;
		for (const chunk of document.cookie.split(";")) {
			const item = chunk.trim();
			if (item.startsWith(prefix)) return decodeURIComponent(item.slice(prefix.length));
		}
	} catch {
		// 读 cookie 也可能被隐私设置拦掉，当作没有
	}
	return null;
}

function writeCookie(name: string, value: string): void {
	if (!isCookieUsable()) return;
	try {
		const encoded = encodeURIComponent(value);
		if (encoded.length > COOKIE_MAX_BYTES) return;
		// 同源 http 下不能带 Secure，否则整条 cookie 会被丢弃
		const secure = window.location.protocol === "https:" ? "; Secure" : "";
		document.cookie = `${name}=${encoded}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
	} catch {
		// 写不进去就算了，localStorage 那份还在
	}
}

function deleteCookie(name: string): void {
	if (!isCookieUsable()) return;
	try {
		document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
	} catch {
		// ignore
	}
}

function parseIdentity(raw: string | null): GuestIdentity | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed.userId !== "string" || !parsed.userId) return null;
		return {
			userId: parsed.userId,
			useraccount: typeof parsed.useraccount === "string" ? parsed.useraccount : "",
			username: typeof parsed.username === "string" ? parsed.username : "",
			avatar: typeof parsed.avatar === "string" ? parsed.avatar : "",
			color: typeof parsed.color === "string" ? parsed.color : "",
		};
	} catch {
		return null;
	}
}

/** 登记游客时调用：localStorage 和 cookie 各写一份 */
export function saveGuestIdentity(identity: GuestIdentity): void {
	const raw = JSON.stringify(identity);
	try {
		localStorage.setItem(STORAGE_KEY, raw);
	} catch {
		console.error("[guest] localStorage 写入失败，只剩 cookie 一份");
	}
	writeCookie(COOKIE_KEY, raw);
}

/**
 * 读取游客身份。localStorage 优先，缺了就回退到 cookie。
 * 只要有一边命中就把另一边补齐，下次少一次回退。
 */
export function loadGuestIdentity(): GuestIdentity | null {
	let raw: string | null = null;
	try {
		raw = localStorage.getItem(STORAGE_KEY);
	} catch {
		raw = null;
	}

	const fromStorage = parseIdentity(raw);
	if (fromStorage) {
		writeCookie(COOKIE_KEY, JSON.stringify(fromStorage));
		return fromStorage;
	}

	const fromCookie = parseIdentity(readCookie(COOKIE_KEY));
	if (!fromCookie) return null;

	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(fromCookie));
	} catch {
		// 补不回去也不影响这次使用
	}
	return fromCookie;
}

/** 只判断在不在，不做补写。给路由守卫这种同步调用点用 */
export function hasGuestIdentity(): boolean {
	try {
		if (parseIdentity(localStorage.getItem(STORAGE_KEY))) return true;
	} catch {
		// 读不到就往下试 cookie
	}
	return Boolean(parseIdentity(readCookie(COOKIE_KEY)));
}

/** 退出登录 / 身份损坏时调用，两份一起清 */
export function clearGuestIdentity(): void {
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// ignore
	}
	deleteCookie(COOKIE_KEY);
}
