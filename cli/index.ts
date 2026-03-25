import { Command } from "commander";
import { depositCommand } from "./deposit";
import { withdrawCommand } from "./withdraw";
import { statusCommand } from "./status";
import { watchCommand } from "./watch";
import { exportNotesCommand, importNotesCommand } from "./backup";

const program = new Command();

program
  .name("zk-mixer")
  .description("ZK Payment Mixer CLI — private ETH deposits and withdrawals")
  .version("0.1.0")
  .option("--verbose", "Enable verbose output");

program.addCommand(depositCommand);
program.addCommand(withdrawCommand);
program.addCommand(statusCommand);
program.addCommand(watchCommand);
program.addCommand(exportNotesCommand);
program.addCommand(importNotesCommand);

program.parse();
