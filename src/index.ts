#!/usr/bin/env bun
import { commandRegister, registerAllCommands } from "./commands.js";

// Register all commands
registerAllCommands();

// Main entry point - parse subcommands
async function main() {
  const args = process.argv.slice(2);

  // Show global help if no command or help flag
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(commandRegister.generateGlobalHelp());
    process.exit(0);
  }

  const commandName = args[0];
  const commandArgs = args.slice(1);

  // Check if command exists
  if (!commandRegister.has(commandName)) {
    console.error(`Unknown command: ${commandName}`);
    console.error("");
    console.log(commandRegister.generateGlobalHelp());
    process.exit(1);
  }

  // Show command-specific help if requested
  if (commandArgs[0] === "--help" || commandArgs[0] === "-h") {
    const helpText = commandRegister.generateCommandHelp(commandName);
    if (helpText) {
      console.log(helpText);
      process.exit(0);
    }
  }

  // Execute command handler
  const command = commandRegister.get(commandName)!;
  await command.handler(commandArgs);
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      error: true,
      code: "FATAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
