import { spawn } from "node:child_process";
import console from "node:console";
import process from "node:process";

const publicPort = process.env.PORT ?? "10000";
const children = [
  spawn(process.execPath, ["apps/api/dist/index.js"], {
    env: { ...process.env, PORT: publicPort },
    stdio: "inherit",
  }),
  spawn(process.execPath, ["apps/relayer/dist/index.js"], {
    env: { ...process.env, METRICS_PORT: "9464", PORT: "9464" },
    stdio: "inherit",
  }),
];

let stopping = false;

function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

for (const child of children) {
  child.on("error", (error) => {
    console.error("demo service child failed to start", error);
    process.exitCode = 1;
    stop("SIGTERM");
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`demo service child exited unexpectedly (${code ?? signal ?? "unknown"})`);
      process.exitCode = code && code !== 0 ? code : 1;
      stop("SIGTERM");
    }
  });
}

await Promise.all(
  children.map(
    (child) =>
      new Promise((resolve) => {
        child.once("exit", resolve);
      }),
  ),
);
