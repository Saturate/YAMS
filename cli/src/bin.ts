import { startCommand } from "./commands/start.js";
import { initCommand } from "./commands/init.js";
import { configCommand } from "./commands/config.js";
import { stopCommand } from "./commands/stop.js";
import { statusCommand } from "./commands/status.js";
import { logsCommand } from "./commands/logs.js";
import { serverSetupCommand } from "./commands/server-setup.js";
import { deployCommand } from "./commands/deploy.js";
import { syncCommand } from "./commands/sync.js";

const args = process.argv.slice(2);
const command = args[0];

function hasFlag(flag: string): boolean {
	return args.includes(`--${flag}`) || args.includes(`-${flag.charAt(0)}`);
}

function getFlagValue(flag: string): string | undefined {
	const idx = args.indexOf(`--${flag}`);
	if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
	return undefined;
}

function showHelp() {
	console.log(`
HUSK — Memory layer for AI coding assistants

Usage: npx husk [command] [options]

Commands:
  (default)      Start HUSK (simple or advanced setup on first run)
  init           Interactive wizard: local install or connect to remote server
  deploy         Generate a deployment prompt for your AI assistant
  server-setup   Set up a fresh remote server (create admin + API key)
  config         View/edit existing husk.toml interactively
  stop           Stop the running server
  status         Show server status, port, version
  sync           Sync memories from AI clients (Claude Code, etc.) into HUSK
  logs           Tail ~/.husk/husk.log

Options:
  --foreground   Run server in foreground (for debugging)
  --update       Re-download server from latest release
  --help, -h     Show this help
  --version, -v  Show version

Logs options:
  --follow, -f   Follow log output (like tail -f)
  --lines, -n    Number of lines to show (default: 50)
`);
}

async function main() {
	if (hasFlag("help") || hasFlag("h")) {
		showHelp();
		return;
	}

	if (hasFlag("version") || hasFlag("v")) {
		console.log("husk 0.1.0");
		return;
	}

	try {
		switch (command) {
			case "init":
				await initCommand();
				break;
			case "deploy":
				await deployCommand();
				break;
			case "server-setup":
				await serverSetupCommand();
				break;
			case "config":
				await configCommand();
				break;
			case "sync":
				await syncCommand();
				break;
			case "stop":
				await stopCommand();
				break;
			case "status":
				await statusCommand();
				break;
			case "logs":
				await logsCommand({
					follow: hasFlag("follow") || hasFlag("f"),
					lines: getFlagValue("lines")
						? parseInt(getFlagValue("lines")!, 10)
						: getFlagValue("n")
							? parseInt(getFlagValue("n")!, 10)
							: undefined,
				});
				break;
			case "help":
				showHelp();
				break;
			default:
				await startCommand({ foreground: hasFlag("foreground") });
				break;
		}
	} catch (err) {
		if (err instanceof Error && err.message.includes("cancelled")) {
			process.exit(0);
		}
		console.error("Error:", err instanceof Error ? err.message : err);
		process.exit(1);
	}
}

main();
