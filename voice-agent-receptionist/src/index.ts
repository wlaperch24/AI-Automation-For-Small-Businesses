import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadRuntimeConfig, runCallSimulator, SimulatorMode } from "./sim/call_simulator";

function parseModeFromArgs(argv: string[]): SimulatorMode | null {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  if (!modeArg) {
    return null;
  }
  const value = modeArg.split("=")[1]?.trim();
  if (value === "voice") {
    return "voice";
  }
  if (value === "text") {
    return "text";
  }
  return null;
}

async function promptMode(): Promise<SimulatorMode> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question("Choose mode: [1] text, [2] voice: ")).trim();
    return answer === "2" ? "voice" : "text";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const mode = parseModeFromArgs(process.argv.slice(2)) ?? (await promptMode());
  const config = loadRuntimeConfig();
  await runCallSimulator(mode, config);
}

main().catch((error) => {
  console.error("[ERROR]", error);
  process.exitCode = 1;
});
