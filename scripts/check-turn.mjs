#!/usr/bin/env node
/**
 * TURN / STUN 体检脚本（零依赖，Node 18+）
 *
 * 用来回答一个具体问题：**为什么局域网能联机、公网不行**。
 * 浏览器那边只会给你一句 "ICE failed"，看不到 TURN 到底哪一步塌了，这个脚本把
 * 中间过程摊开：端口通不通、STUN 报的公网地址对不对、TURN 认证过不过、
 * 以及最要命的那条 —— **服务器分配的中继地址是不是公网可达**。
 *
 * coturn 少配一个 external-ip 时，它会把自己网卡上的内网地址（阿里云 ECS 上通常是
 * 172.x / 10.x）当作 relay candidate 发给浏览器。ICE 看着有 relay 候选，实际那个地址
 * 在公网上根本路由不到，于是只有同一局域网内的两台设备能连上 —— 和"没有 TURN"
 * 表现完全一样，但更难查，因为端口、认证、日志全是正常的。
 *
 * 用法：
 *   node scripts/check-turn.mjs                          # 从 .env 读 TURN_URL / 端口 / TURN_SECRET
 *   node scripts/check-turn.mjs 116.62.47.225            # 指定主机
 *   node scripts/check-turn.mjs 116.62.47.225 3478 5349  # 指定主机 + 明文端口 + TLS 端口
 *
 * 退出码：0 = 全部通过，1 = 有致命问题（公网联机会挂）
 */

import dgram from "node:dgram";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── STUN/TURN 协议常量 ───────────────────────────────────────────────
const MAGIC = 0x2112a442;
const METHOD = { BINDING: 0x0001, ALLOCATE: 0x0003 };
const CLASS = { REQUEST: 0x0000, SUCCESS: 0x0100, ERROR: 0x0110 };
const ATTR = {
	MAPPED_ADDRESS: 0x0001,
	USERNAME: 0x0006,
	MESSAGE_INTEGRITY: 0x0008,
	ERROR_CODE: 0x0009,
	REALM: 0x0014,
	NONCE: 0x0015,
	XOR_RELAYED_ADDRESS: 0x0016,
	REQUESTED_TRANSPORT: 0x0019,
	XOR_MAPPED_ADDRESS: 0x0020,
	SOFTWARE: 0x8022,
};

const C = {
	ok: (s) => `\x1b[32m${s}\x1b[0m`,
	bad: (s) => `\x1b[31m${s}\x1b[0m`,
	warn: (s) => `\x1b[33m${s}\x1b[0m`,
	dim: (s) => `\x1b[2m${s}\x1b[0m`,
	b: (s) => `\x1b[1m${s}\x1b[0m`,
};

const problems = [];
const fail = (msg, fix) => problems.push({ level: "fatal", msg, fix });
const warn = (msg, fix) => problems.push({ level: "warn", msg, fix });

// ── 报文编解码 ───────────────────────────────────────────────────────
function pad4(n) {
	return (4 - (n % 4)) % 4;
}

function encodeAttr(type, value) {
	const head = Buffer.alloc(4);
	head.writeUInt16BE(type, 0);
	head.writeUInt16BE(value.length, 2);
	return Buffer.concat([head, value, Buffer.alloc(pad4(value.length))]);
}

function buildMessage(method, cls, txId, attrs, integrityKey) {
	let body = Buffer.concat(attrs);
	const header = Buffer.alloc(20);
	header.writeUInt16BE(method | cls, 0);
	header.writeUInt32BE(MAGIC, 4);
	txId.copy(header, 8);

	if (integrityKey) {
		// MESSAGE-INTEGRITY 的 HMAC 要按"已经含有该属性"的长度来算：
		// 先把 length 写成 body + 24（4 字节属性头 + 20 字节摘要），再对
		// header+body 求 HMAC，最后才把属性追加上去。顺序反了摘要就对不上。
		header.writeUInt16BE(body.length + 24, 2);
		const mac = crypto.createHmac("sha1", integrityKey).update(Buffer.concat([header, body])).digest();
		body = Buffer.concat([body, encodeAttr(ATTR.MESSAGE_INTEGRITY, mac)]);
	}
	header.writeUInt16BE(body.length, 2);
	return Buffer.concat([header, body]);
}

function decodeMessage(buf) {
	if (buf.length < 20) return null;
	const type = buf.readUInt16BE(0);
	const len = buf.readUInt16BE(2);
	const attrs = new Map();
	let off = 20;
	const end = Math.min(20 + len, buf.length);
	while (off + 4 <= end) {
		const at = buf.readUInt16BE(off);
		const al = buf.readUInt16BE(off + 2);
		attrs.set(at, buf.subarray(off + 4, off + 4 + al));
		off += 4 + al + pad4(al);
	}
	return { cls: type & 0x0110, method: type & 0x3eef, attrs };
}

function readAddress(buf, xor, txId) {
	if (!buf || buf.length < 8) return null;
	let port = buf.readUInt16BE(2);
	let ip = Buffer.from(buf.subarray(4, 8));
	if (xor) {
		port ^= MAGIC >>> 16;
		const mask = Buffer.alloc(4);
		mask.writeUInt32BE(MAGIC);
		for (let i = 0; i < 4; i++) ip[i] ^= mask[i];
	}
	return { ip: Array.from(ip).join("."), port };
}

function readError(attrs) {
	const v = attrs.get(ATTR.ERROR_CODE);
	if (!v) return null;
	return { code: v[2] * 100 + v[3], reason: v.subarray(4).toString("utf8") };
}

function isPrivate(ip) {
	const p = ip.split(".").map(Number);
	return (
		p[0] === 10 ||
		p[0] === 127 ||
		(p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
		(p[0] === 192 && p[1] === 168) ||
		(p[0] === 169 && p[1] === 254) ||
		(p[0] === 100 && p[1] >= 64 && p[1] <= 127) // CGNAT
	);
}

// ── 传输层 ───────────────────────────────────────────────────────────
function udpExchange(host, port, msg, timeout = 3000, retries = 2) {
	return new Promise((resolve, reject) => {
		const sock = dgram.createSocket("udp4");
		let attempt = 0;
		let timer;
		const cleanup = () => {
			clearTimeout(timer);
			try {
				sock.close();
			} catch {}
		};
		const send = () => {
			attempt++;
			sock.send(msg, port, host, (err) => {
				if (err) {
					cleanup();
					reject(err);
				}
			});
			timer = setTimeout(() => {
				// UDP 没有重传，首包丢了就得自己再发一次，否则很容易误判成"端口不通"
				if (attempt <= retries) send();
				else {
					cleanup();
					reject(new Error("timeout"));
				}
			}, timeout);
		};
		sock.on("message", (data) => {
			cleanup();
			resolve(data);
		});
		sock.on("error", (err) => {
			cleanup();
			reject(err);
		});
		send();
	});
}

function streamExchange(createSocket, msg, timeout = 4000) {
	return new Promise((resolve, reject) => {
		const sock = createSocket();
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("timeout"));
		}, timeout);
		sock.on("connect", () => sock.write(msg));
		sock.on("secureConnect", () => sock.write(msg));
		sock.on("data", (data) => {
			clearTimeout(timer);
			sock.destroy();
			resolve(data);
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			sock.destroy();
			reject(err);
		});
	});
}

// ── 检查项 ───────────────────────────────────────────────────────────
async function checkStun(host, port) {
	console.log(C.b(`\n[1/4] STUN Binding  udp://${host}:${port}`));
	const txId = crypto.randomBytes(12);
	let res;
	try {
		res = decodeMessage(await udpExchange(host, port, buildMessage(METHOD.BINDING, CLASS.REQUEST, txId, [])));
	} catch (e) {
		console.log(`  ${C.bad("✗")} 无响应（${e.message}）`);
		fail(
			`STUN ${host}:${port}/udp 无响应`,
			"确认 coturn 在跑，且云安全组/防火墙放行了 UDP " + port,
		);
		return null;
	}
	const soft = res.attrs.get(ATTR.SOFTWARE);
	if (soft) console.log(`  ${C.dim("SOFTWARE  " + soft.toString("utf8").trim())}`);
	const mapped =
		readAddress(res.attrs.get(ATTR.XOR_MAPPED_ADDRESS), true, txId) ||
		readAddress(res.attrs.get(ATTR.MAPPED_ADDRESS), false, txId);
	if (!mapped) {
		console.log(`  ${C.bad("✗")} 响应里没有 MAPPED-ADDRESS`);
		fail("STUN 响应缺少映射地址", "对面可能不是 STUN 服务器");
		return null;
	}
	console.log(`  ${C.ok("✓")} 服务器看到的你是 ${C.b(mapped.ip + ":" + mapped.port)}`);
	return mapped;
}

async function allocate(host, port, transport, secret, tlsPort) {
	const label = transport === "udp" ? `udp://${host}:${port}` : transport === "tcp" ? `tcp://${host}:${port}` : `tls://${host}:${tlsPort}`;
	const exchange = (msg) => {
		if (transport === "udp") return udpExchange(host, port, msg);
		if (transport === "tcp") return streamExchange(() => net.connect(port, host), msg);
		return streamExchange(() => tls.connect({ host, port: tlsPort, rejectUnauthorized: false }), msg);
	};

	const reqTransport = encodeAttr(ATTR.REQUESTED_TRANSPORT, Buffer.from([0x11, 0, 0, 0])); // UDP
	const txId = crypto.randomBytes(12);
	let res;
	try {
		res = decodeMessage(await exchange(buildMessage(METHOD.ALLOCATE, CLASS.REQUEST, txId, [reqTransport])));
	} catch (e) {
		return { label, error: e.message };
	}

	// 正常的 coturn 第一次一定回 401，带上 realm/nonce 让你重签
	const err = readError(res.attrs);
	if (err?.code === 401 || err?.code === 438) {
		const realm = res.attrs.get(ATTR.REALM)?.toString("utf8") ?? "";
		const nonce = res.attrs.get(ATTR.NONCE);
		if (!secret) return { label, needsAuth: true, realm, authTested: false };

		const ttl = Number(process.env.TURN_TTL || 86400);
		const username = `${Math.floor(Date.now() / 1000) + ttl}:turn-healthcheck`;
		const password = crypto.createHmac("sha1", secret).update(username).digest("base64");
		const key = crypto.createHash("md5").update(`${username}:${realm}:${password}`).digest();
		const txId2 = crypto.randomBytes(12);
		try {
			res = decodeMessage(
				await exchange(
					buildMessage(
						METHOD.ALLOCATE,
						CLASS.REQUEST,
						txId2,
						[
							reqTransport,
							encodeAttr(ATTR.USERNAME, Buffer.from(username, "utf8")),
							encodeAttr(ATTR.REALM, Buffer.from(realm, "utf8")),
							encodeAttr(ATTR.NONCE, nonce ?? Buffer.alloc(0)),
						],
						key,
					),
				),
			);
		} catch (e) {
			return { label, error: e.message, realm };
		}
		const err2 = readError(res.attrs);
		if (err2) return { label, authFailed: true, realm, code: err2.code, reason: err2.reason };
		return { label, realm, authTested: true, relay: readAddress(res.attrs.get(ATTR.XOR_RELAYED_ADDRESS), true) };
	}

	if (err) return { label, error: `${err.code} ${err.reason}` };
	// 没要凭证就直接分配成功 = 开放中继
	return { label, openRelay: true, relay: readAddress(res.attrs.get(ATTR.XOR_RELAYED_ADDRESS), true) };
}

async function checkTurn(host, port, tlsPort, secret) {
	console.log(C.b(`\n[2/4] TURN Allocate`));
	const results = [];
	for (const transport of ["udp", "tcp"]) {
		const r = await allocate(host, port, transport, secret, tlsPort);
		results.push(r);
		if (r.error) {
			console.log(`  ${C.bad("✗")} ${r.label}  ${r.error}`);
			continue;
		}
		if (r.authFailed) {
			console.log(`  ${C.bad("✗")} ${r.label}  认证被拒 ${r.code} ${r.reason}  ${C.dim("realm=" + r.realm)}`);
			fail(
				`TURN 认证失败（${r.code} ${r.reason}）`,
				"coturn 的 static-auth-secret 和服务端 .env 的 TURN_SECRET 必须完全一致，且 coturn 要开 use-auth-secret",
			);
			continue;
		}
		if (r.needsAuth) {
			console.log(`  ${C.warn("?")} ${r.label}  需要凭证但没提供 ${C.dim("realm=" + r.realm)}`);
			warn("没有 TURN_SECRET，跳过了认证检查", "带上 TURN_SECRET 环境变量重跑，才能验证凭证是否匹配");
			continue;
		}
		if (r.openRelay) {
			console.log(`  ${C.warn("!")} ${r.label}  ${C.warn("不需要任何凭证就分配成功")}`);
			warn(
				"TURN 是开放中继：任何人都能免费用它转发流量",
				"给 coturn 打开 use-auth-secret + static-auth-secret（与 TURN_SECRET 一致）",
			);
		}
		if (r.relay) {
			const priv = isPrivate(r.relay.ip);
			const mark = priv ? C.bad("✗") : C.ok("✓");
			console.log(`  ${mark} ${r.label}  中继地址 ${C.b(r.relay.ip + ":" + r.relay.port)}${priv ? C.bad("  ← 内网地址，公网不可达") : ""}`);
			if (priv) {
				fail(
					`TURN 分配出的中继地址是内网 IP ${r.relay.ip} —— 这就是"只有局域网能联机"的原因`,
					`给 coturn 配 external-ip=<公网IP>/<内网IP>（本机就是 ${host}/${r.relay.ip}），改完重启 coturn`,
				);
			}
		} else if (!r.needsAuth) {
			console.log(`  ${C.bad("✗")} ${r.label}  分配成功但没返回中继地址`);
		}
	}
	return results;
}

async function checkTls(host, tlsPort) {
	console.log(C.b(`\n[3/4] TURN over TLS  tls://${host}:${tlsPort}`));
	await new Promise((resolve) => {
		const sock = tls.connect({ host, port: tlsPort, rejectUnauthorized: false, timeout: 4000 }, () => {
			const cert = sock.getPeerCertificate();
			console.log(`  ${C.ok("✓")} 端口在监听，证书 CN=${cert?.subject?.CN ?? "?"} 到期 ${cert?.valid_to ?? "?"}`);
			if (net.isIP(host)) {
				warn(
					"用裸 IP 部署时 turns: 基本用不了：公共 CA 不给 IP 签证书，浏览器会拒绝",
					"要么上域名 + 证书，要么在服务端 .env 里设 TURN_TLS_ENABLED=false，别把死的 turns: 下发给浏览器",
				);
			}
			sock.destroy();
			resolve();
		});
		sock.on("timeout", () => {
			sock.destroy();
			resolve();
		});
		sock.on("error", (e) => {
			console.log(`  ${C.bad("✗")} 连不上（${e.code || e.message}）`);
			warn(
				`TURN_PORT ${tlsPort} 上没有 TLS 监听`,
				"服务端 .env 设 TURN_TLS_ENABLED=false，否则每个玩家都要为这条无效的 turns: 白等一轮超时",
			);
			resolve();
		});
	});
}

function checkRelayPorts(host) {
	console.log(C.b(`\n[4/4] 中继端口段`));
	console.log(
		`  ${C.dim("提示")} coturn 的 relay-ports（默认 49160-49200）必须整段在云安全组里放行 UDP，` +
			`\n       只放 3478 是不够的 —— Allocate 会成功，但真正的数据走的是这一段。`,
	);
}

// ── 读 .env ──────────────────────────────────────────────────────────
function loadEnv() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	for (const file of [".env", ".env.local"]) {
		const p = path.join(root, file);
		if (!fs.existsSync(p)) continue;
		for (const line of fs.readFileSync(p, "utf8").split("\n")) {
			const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
			if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
		}
	}
}

// ── main ────────────────────────────────────────────────────────────
loadEnv();
const [argHost, argPort, argTlsPort] = process.argv.slice(2);
const host = argHost || process.env.TURN_URL || process.env.MONOPOLY_DOMAIN;
const port = Number(argPort || process.env.STUN_PORT || 3478);
const tlsPort = Number(argTlsPort || process.env.TURN_PORT || 5349);
const secret = process.env.TURN_SECRET;

if (!host) {
	console.error("用法: node scripts/check-turn.mjs <host> [stunPort] [tlsPort]  （或在 .env 里配 TURN_URL）");
	process.exit(2);
}

console.log(C.b(`TURN 体检  ${host}  明文端口 ${port}  TLS 端口 ${tlsPort}  ${secret ? "" : C.dim("(未提供 TURN_SECRET)")}`));

const mapped = await checkStun(host, port);
await checkTurn(host, port, tlsPort, secret);
await checkTls(host, tlsPort);
checkRelayPorts(host);

console.log(C.b("\n─── 结论 ───"));
if (!problems.length) {
	console.log(`${C.ok("✓")} 没发现问题，公网玩家应该能通过 relay 连上。`);
	process.exit(0);
}
for (const p of problems) {
	console.log(`${p.level === "fatal" ? C.bad("✗ 致命") : C.warn("! 注意")}  ${p.msg}`);
	console.log(`        ${C.dim("→ " + p.fix)}`);
}
process.exit(problems.some((p) => p.level === "fatal") ? 1 : 0);
