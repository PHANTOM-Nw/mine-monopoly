import crypto from "crypto";
import { env } from "@mine-monopoly/env";

type IceServer = {
	urls: string;
	username?: string;
	credential?: string;
};

function getStunUrl(): string {
	return `stun:${env<string>("TURN_URL")}:${env<number>("STUN_PORT")}`;
}

/**
 * 是否下发 turns:（TURN over TLS）。
 *
 * turns: 要求 coturn 真的在 TURN_PORT 上监听且证书对得上域名 —— 裸 IP 部署签不出
 * 公共 CA 证书，端口多半也没起。这种情况下把 turns: 塞进 iceServers 只会让浏览器
 * 白等一轮连接失败，所以默认跟随站点协议，并允许用 TURN_TLS_ENABLED 显式覆盖。
 */
function isTurnTlsEnabled(): boolean {
	const explicit = env<string>("TURN_TLS_ENABLED", "");
	if (explicit) return explicit === "true" || explicit === "1";
	return env<string>("PROTOCOL", "http") === "https";
}

function getTurnUrls(): string[] {
	const baseUrl = env<string>("TURN_URL");
	const tlsPort = env<number>("TURN_PORT");
	const plainPort = env<number>("STUN_PORT"); // 3478
	// 多条路径都给上，让 ICE 自己挑：UDP 最快，TCP 用来兜住封 UDP 的网络。
	const urls = [
		`turn:${baseUrl}:${plainPort}?transport=udp`,
		`turn:${baseUrl}:${plainPort}?transport=tcp`,
	];
	if (isTurnTlsEnabled()) {
		urls.push(`turns:${baseUrl}:${tlsPort}?transport=tcp`); // TLS，穿过只放行 443/TLS 的网络
	}
	return urls;
}

function generateTurnCredentials(userId: string): { username: string; credential: string } {
	// env() 返回字符串，TURN_TTL 不匹配 PORT 模式不会被自动转为 number
	// 必须显式 Number() 否则数字+字符串会变成字符串拼接 → HMAC 永远不匹配
	const ttl = Number(env("TURN_TTL"));
	const secret = env<string>("TURN_SECRET");
	const timestamp = Math.floor(Date.now() / 1000) + ttl;
	const username = `${timestamp}:${userId}`;
	const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
	return { username, credential };
}

/**
 * 生成 iceServers 配置：STUN + TURN（带 HMAC 动态凭证）。
 *
 * 游客同样要给 TURN。公网上大量玩家在对称 NAT / 运营商 CGNAT 后面，打洞必然失败，
 * 只有 relay 能连上 —— 以前游客只拿 STUN，表现就是"局域网能玩、公网连不上"。
 * userId 只是写进 TURN username 里方便在 coturn 侧区分用量，不参与鉴权。
 */
export function generateIceServers(userId?: string): IceServer[] {
	const servers: IceServer[] = [{ urls: getStunUrl() }];
	const { username, credential } = generateTurnCredentials(userId || "guest");
	for (const url of getTurnUrls()) {
		servers.push({ urls: url, username, credential });
	}
	return servers;
}
