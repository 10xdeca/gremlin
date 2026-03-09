/**
 * Docker Engine API client over Unix socket.
 *
 * Talks to the Docker daemon at /var/run/docker.sock to read container logs,
 * inspect container status, and restart the container. Used by the server-ops
 * tools for self-diagnostics and self-repair.
 *
 * All functions gracefully return error messages if the Docker socket isn't
 * available (e.g. running in local dev outside Docker).
 */

import http from "http";

const DOCKER_SOCKET = "/var/run/docker.sock";
const CONTAINER_NAME = "gremlin";

/** Make an HTTP request to the Docker Engine API over the Unix socket. */
function dockerRequest(
  method: string,
  path: string,
  options?: { timeout?: number; rawBuffer?: boolean }
): Promise<{ statusCode: number; body: string | Buffer }> {
  const timeout = options?.timeout ?? 10_000;
  const rawBuffer = options?.rawBuffer ?? false;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path,
        method,
        headers: { "Content-Type": "application/json" },
        timeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode ?? 0,
            body: rawBuffer ? buf : buf.toString("utf-8"),
          });
        });
      }
    );

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Docker API request timed out"));
    });
    req.end();
  });
}

/**
 * Parse Docker multiplexed stream format.
 *
 * Each frame has an 8-byte header:
 *   - byte 0: stream type (1=stdout, 2=stderr)
 *   - bytes 1-3: padding
 *   - bytes 4-7: payload size (big-endian uint32)
 *
 * Returns the decoded log lines as a string.
 */
function parseDockerLogs(raw: Buffer): string {
  const lines: string[] = [];
  let offset = 0;

  while (offset + 8 <= raw.length) {
    const payloadSize = raw.readUInt32BE(offset + 4);
    if (offset + 8 + payloadSize > raw.length) break;

    const payload = raw.subarray(offset + 8, offset + 8 + payloadSize);
    lines.push(payload.toString("utf-8"));
    offset += 8 + payloadSize;
  }

  return lines.join("");
}

/** Maximum log output size returned to the agent (~50 KB). */
const MAX_LOG_SIZE = 50_000;

/**
 * Fetch recent container logs.
 * @param tail Number of lines to fetch (default 100).
 * @param filter Optional text filter — only lines containing this string are returned.
 */
export async function getContainerLogs(
  tail = 100,
  filter?: string
): Promise<string> {
  try {
    const res = await dockerRequest(
      "GET",
      `/containers/${CONTAINER_NAME}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=1`,
      { rawBuffer: true }
    );

    if (res.statusCode !== 200) {
      return `Docker API error (${res.statusCode}): ${res.body.toString()}`;
    }

    let logs = parseDockerLogs(res.body as Buffer);

    if (filter) {
      logs = logs
        .split("\n")
        .filter((line) => line.toLowerCase().includes(filter.toLowerCase()))
        .join("\n");
    }

    if (logs.length > MAX_LOG_SIZE) {
      logs = logs.slice(-MAX_LOG_SIZE) + "\n\n[truncated — showing last 50 KB]";
    }

    return logs || "(no matching log lines)";
  } catch (err) {
    return `Docker socket unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export interface ContainerInfo {
  status: string;
  state: string;
  startedAt: string;
  restartCount: number;
  created: string;
  image: string;
}

/** Get container status, uptime, and restart count. */
export async function getContainerInfo(): Promise<ContainerInfo | string> {
  try {
    const res = await dockerRequest(
      "GET",
      `/containers/${CONTAINER_NAME}/json`
    );

    if (res.statusCode !== 200) {
      return `Docker API error (${res.statusCode}): ${res.body}`;
    }

    const data = JSON.parse(res.body as string);

    return {
      status: data.State?.Status ?? "unknown",
      state: data.State?.Running ? "running" : "stopped",
      startedAt: data.State?.StartedAt ?? "unknown",
      restartCount: data.RestartCount ?? 0,
      created: data.Created ?? "unknown",
      image: data.Config?.Image ?? "unknown",
    };
  } catch (err) {
    return `Docker socket unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Restart the bot container via Docker API.
 * Uses a 5-second graceful shutdown timeout.
 * Docker's `restart: unless-stopped` policy brings the container back automatically.
 */
export async function restartContainer(): Promise<string> {
  try {
    const res = await dockerRequest(
      "POST",
      `/containers/${CONTAINER_NAME}/restart?t=5`,
      { timeout: 30_000 }
    );

    if (res.statusCode === 204) {
      return "Container restart initiated successfully";
    }

    return `Docker API error (${res.statusCode}): ${res.body}`;
  } catch (err) {
    return `Docker socket unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}
