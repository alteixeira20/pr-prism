import { execFileSync, spawnSync } from "node:child_process";
import dns from "node:dns";
import { readFileSync } from "node:fs";
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
  readonly violations: readonly NetworkViolation[];
  restore: () => void;
  assertZeroViolations: () => void;
  clearDemonstratedViolation: () => void;
  runWithNegativeControlIsolation: <T>(fn: (negativeViolations: NetworkViolation[]) => Promise<T> | T) => Promise<T>;
}

/**
 * Installs comprehensive in-process monkeypatches across fetch, http, https,
 * raw net.Socket, tls, and dns to establish a strict offline boundary.
 */
export function installNetworkGuard(): NetworkGuard {
  const applicationViolations: NetworkViolation[] = [];
  let activeNegativeControlSink: NetworkViolation[] | null = null;

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
    if (activeNegativeControlSink) {
      activeNegativeControlSink.push(violation);
    } else {
      applicationViolations.push(violation);
    }
    const err = new Error(
      `CRITICAL VIOLATION: Offline network guard intercepted prohibited ${protocol} call` +
        (target ? ` to ${target}` : ""),
    );
    (err as any).code = "ERR_NETWORK_PROHIBITED";
    return err;
  };

  // 1. globalThis.fetch (intercepted before any undici connection)
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
    // If connecting to a unix domain socket / local IPC pipe, allow local IPC
    const firstArg = args[0];
    if (typeof firstArg === "string" && !firstArg.includes(":")) {
      return originalNetConnect.apply(this, args as any);
    }
    if (typeof firstArg === "object" && firstArg !== null && typeof firstArg.path === "string") {
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
    if (applicationViolations.length > 0) {
      throw new Error(
        `ASSERTION FAILED: Expected 0 network violations, but recorded ${applicationViolations.length}:\n` +
          applicationViolations.map((v) => `  - [${v.protocol}] ${v.target ?? "unspecified"}`).join("\n"),
      );
    }
  };

  const clearDemonstratedViolation = () => {
    applicationViolations.length = 0;
  };

  const runWithNegativeControlIsolation = async <T>(
    fn: (negativeViolations: NetworkViolation[]) => Promise<T> | T,
  ): Promise<T> => {
    const scopedSink: NetworkViolation[] = [];
    const prevSink = activeNegativeControlSink;
    activeNegativeControlSink = scopedSink;
    try {
      return await fn(scopedSink);
    } finally {
      activeNegativeControlSink = prevSink;
    }
  };

  return {
    get violations() {
      return applicationViolations;
    },
    restore,
    assertZeroViolations,
    clearDemonstratedViolation,
    runWithNegativeControlIsolation,
  };
}

/**
 * Returns true if the current Linux process is running inside an isolated network namespace
 * where /proc/net/dev contains only the loopback interface.
 */
export function isCurrentProcessInNetworkNamespace(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const content = readFileSync("/proc/net/dev", "utf-8");
    const interfaces = content
      .split("\n")
      .slice(2)
      .map((line) => line.split(":")[0]?.trim())
      .filter(Boolean);
    return interfaces.length === 1 && interfaces[0] === "lo";
  } catch {
    return false;
  }
}

/**
 * Checks whether Linux bubblewrap (bwrap) or an active isolated network namespace
 * is available with unshare-net support.
 */
export function isOsNetworkIsolationSupported(): boolean {
  if (process.platform !== "linux") return false;
  // If the current process is already inside a kernel-isolated network namespace,
  // OS-level isolation is verified and active.
  if (isCurrentProcessInNetworkNamespace()) return true;
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
 * Asserts that Linux bubblewrap OS-level network isolation is available.
 * Throws an explicit error if unsupported to ensure unsupported hosts are never
 * silently counted as verified.
 */
export function assertOsNetworkIsolationSupported(): void {
  if (!isOsNetworkIsolationSupported()) {
    throw new Error(
      "OS-level network isolation (bwrap --unshare-net) is UNVERIFIED on this host. " +
        "Host kernel lacks unprivileged user namespace / bwrap support.",
    );
  }
}

/**
 * Executes a command inside an OS-level network-isolated sandbox (bwrap --unshare-net).
 * If the current process is already inside an isolated network namespace, child processes
 * inherit that isolation directly without nested bwrap invocation.
 */
export function execInOsNetworkSandbox(
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): string {
  assertOsNetworkIsolationSupported();

  if (isCurrentProcessInNetworkNamespace()) {
    return execFileSync(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 15000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  const bwrapArgs = ["--unshare-net", "--dev-bind", "/", "/", cmd, ...args];
  return execFileSync("bwrap", bwrapArgs, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout ?? 15000,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}
