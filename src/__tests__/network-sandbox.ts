import { execFileSync, spawnSync } from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export interface NetworkViolation {
  protocol: string;
  target?: string;
  timestamp: number;
}

export interface NetworkGuard {
  violations: NetworkViolation[];
  restore: () => void;
  assertZeroViolations: () => void;
}

/**
 * Installs comprehensive in-process monkeypatches across fetch, http, https,
 * raw net.Socket, tls, and dns to establish a strict offline boundary.
 */
export function installNetworkGuard(): NetworkGuard {
  const violations: NetworkViolation[] = [];

  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpGet = http.get;
  const originalHttpsRequest = https.request;
  const originalHttpsGet = https.get;
  const originalNetConnect = net.Socket.prototype.connect;
  const originalTlsConnect = tls.connect;
  const originalDnsLookup = dns.lookup;
  const originalDnsPromisesLookup = dns.promises?.lookup;

  const recordViolation = (protocol: string, target?: string) => {
    const violation: NetworkViolation = {
      protocol,
      target,
      timestamp: Date.now(),
    };
    violations.push(violation);
    const err = new Error(
      `CRITICAL VIOLATION: Offline network guard intercepted prohibited ${protocol} call` +
        (target ? ` to ${target}` : ""),
    );
    (err as any).code = "ERR_NETWORK_PROHIBITED";
    return err;
  };

  // 1. globalThis.fetch
  globalThis.fetch = (async (input: any, ..._args: any[]) => {
    const target = typeof input === "string" ? input : input?.url || String(input);
    throw recordViolation("globalThis.fetch", target);
  }) as any;

  // 2. http.request & http.get
  http.request = ((...args: any[]) => {
    const target = typeof args[0] === "string" ? args[0] : args[0]?.host || args[0]?.hostname || "unknown";
    throw recordViolation("http.request", target);
  }) as any;

  http.get = ((...args: any[]) => {
    const target = typeof args[0] === "string" ? args[0] : args[0]?.host || args[0]?.hostname || "unknown";
    throw recordViolation("http.get", target);
  }) as any;

  // 3. https.request & https.get
  https.request = ((...args: any[]) => {
    const target = typeof args[0] === "string" ? args[0] : args[0]?.host || args[0]?.hostname || "unknown";
    throw recordViolation("https.request", target);
  }) as any;

  https.get = ((...args: any[]) => {
    const target = typeof args[0] === "string" ? args[0] : args[0]?.host || args[0]?.hostname || "unknown";
    throw recordViolation("https.get", target);
  }) as any;

  // 4. net.Socket.prototype.connect (intercepts all TCP connection attempts)
  net.Socket.prototype.connect = function (...args: any[]) {
    // If connecting to a unix domain socket / local IPC pipe (e.g. string path or options.path), allow IPC
    const firstArg = args[0];
    if (typeof firstArg === "string" && !firstArg.includes(":")) {
      // Unix domain socket path
      return originalNetConnect.apply(this, args as any);
    }
    if (typeof firstArg === "object" && firstArg !== null && typeof firstArg.path === "string") {
      // Unix domain socket options
      return originalNetConnect.apply(this, args as any);
    }

    const host = typeof firstArg === "object" ? firstArg?.host : typeof args[1] === "string" ? args[1] : "unknown";
    const port = typeof firstArg === "object" ? firstArg?.port : typeof firstArg === "number" ? firstArg : "unknown";
    const target = `${host}:${port}`;
    const err = recordViolation("net.Socket.connect", target);
    process.nextTick(() => {
      this.destroy(err);
    });
    return this;
  };

  // 5. tls.connect
  (tls as any).connect = (...args: any[]) => {
    const firstArg = args[0];
    const host = typeof firstArg === "object" ? firstArg?.host : typeof args[1] === "string" ? args[1] : "unknown";
    const port = typeof firstArg === "object" ? firstArg?.port : typeof firstArg === "number" ? firstArg : "443";
    throw recordViolation("tls.connect", `${host}:${port}`);
  };

  // 6. dns.lookup
  dns.lookup = ((...args: any[]) => {
    const hostname = typeof args[0] === "string" ? args[0] : "unknown";
    const cb = args.find((a) => typeof a === "function");
    const err = recordViolation("dns.lookup", hostname);
    if (cb) {
      process.nextTick(() => cb(err));
      return undefined as any;
    }
    throw err;
  }) as any;

  if (dns.promises) {
    dns.promises.lookup = (async (...args: any[]) => {
      const hostname = typeof args[0] === "string" ? args[0] : "unknown";
      throw recordViolation("dns.promises.lookup", hostname);
    }) as any;
  }

  const restore = () => {
    globalThis.fetch = originalFetch;
    http.request = originalHttpRequest;
    http.get = originalHttpGet;
    https.request = originalHttpsRequest;
    https.get = originalHttpsGet;
    net.Socket.prototype.connect = originalNetConnect;
    tls.connect = originalTlsConnect;
    dns.lookup = originalDnsLookup;
    if (dns.promises && originalDnsPromisesLookup) {
      dns.promises.lookup = originalDnsPromisesLookup;
    }
  };

  const assertZeroViolations = () => {
    if (violations.length > 0) {
      throw new Error(
        `ASSERTION FAILED: Expected 0 network violations, but recorded ${violations.length}:\n` +
          violations.map((v) => `  - [${v.protocol}] ${v.target ?? "unspecified"}`).join("\n"),
      );
    }
  };

  return {
    violations,
    restore,
    assertZeroViolations,
  };
}

/**
 * Checks whether Linux bubblewrap (bwrap) is available with unshare-net support.
 */
export function isOsNetworkIsolationSupported(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const result = spawnSync("bwrap", ["--unshare-net", "--dev-bind", "/", "/", "true"], {
      stdio: "ignore",
      timeout: 2000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Executes a command inside an OS-level network-isolated sandbox (bwrap --unshare-net).
 */
export function execInOsNetworkSandbox(
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): string {
  if (!isOsNetworkIsolationSupported()) {
    throw new Error("OS-level network isolation (bwrap --unshare-net) is not supported on this host");
  }

  const bwrapArgs = ["--unshare-net", "--dev-bind", "/", "/", cmd, ...args];
  return execFileSync("bwrap", bwrapArgs, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout ?? 10000,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}
