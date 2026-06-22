import { runStandaloneProbe } from "./poller.js";

runStandaloneProbe(process.argv.slice(2)).catch(err => {
  console.error(`[probe] fatal: ${err?.stack || err?.message || err}`);
  process.exitCode = 1;
});
