import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import { banner, handleCancel } from "../lib/ui.js";

const DOCS_BASE = "https://husk.akj.io/docs";
const DOCS = {
	quickStart: `${DOCS_BASE}/quick-start`,
	deployment: `${DOCS_BASE}/deployment`,
	configuration: `${DOCS_BASE}/configuration`,
	connecting: `${DOCS_BASE}/connecting`,
};

export async function deployCommand() {
	banner();

	p.log.info(
		"This will generate a prompt you can paste into an AI assistant (Claude, ChatGPT, etc.) to help you deploy HUSK on a remote server.",
	);

	// Gather context so the prompt is tailored
	const domain = await p.text({
		message: "What domain will HUSK run on?",
		placeholder: "husk.example.com",
	});
	handleCancel(domain);

	const provider = await p.select({
		message: "Where are you deploying?",
		options: [
			{ value: "vps", label: "VPS / bare metal", hint: "Ubuntu, Debian, etc." },
			{ value: "docker", label: "Docker host", hint: "Docker already installed" },
			{ value: "cloud", label: "Cloud platform", hint: "AWS, GCP, Azure, etc." },
			{ value: "other", label: "Other / not sure" },
		],
	});
	handleCancel(provider);

	const proxy = await p.select({
		message: "Reverse proxy for HTTPS:",
		options: [
			{ value: "caddy", label: "Caddy (recommended)", hint: "Auto TLS, zero config" },
			{ value: "nginx", label: "nginx" },
			{ value: "traefik", label: "Traefik" },
			{ value: "none", label: "None / I'll handle TLS myself" },
		],
	});
	handleCancel(proxy);

	const storage = await p.select({
		message: "Vector storage:",
		options: [
			{ value: "sqlite-vec", label: "sqlite-vec (recommended)", hint: "Embedded, no extra service" },
			{ value: "qdrant", label: "Qdrant", hint: "Separate vector DB" },
		],
	});
	handleCancel(storage);

	const embeddings = await p.select({
		message: "Embedding provider:",
		options: [
			{ value: "transformers", label: "Transformers (recommended)", hint: "Local, no API key" },
			{ value: "ollama", label: "Ollama", hint: "Local, needs GPU for speed" },
			{ value: "openai", label: "OpenAI", hint: "API key required" },
			{ value: "voyage", label: "Voyage AI", hint: "API key required" },
		],
	});
	handleCancel(embeddings);

	// Build the prompt
	const prompt = generatePrompt({
		domain,
		provider,
		proxy,
		storage,
		embeddings,
	});

	// Try to copy to clipboard
	const copied = tryClipboard(prompt);

	console.log();
	if (copied) {
		p.log.success("Prompt copied to clipboard!");
		p.log.info("Paste it into Claude, ChatGPT, or any AI assistant to get deployment help.");
	} else {
		p.log.info("Copy the prompt below and paste it into your AI assistant:");
	}

	console.log();
	console.log("─".repeat(60));
	console.log(prompt);
	console.log("─".repeat(60));

	console.log();
	p.note(
		[
			"1. Paste the prompt into your AI assistant",
			"2. Follow its instructions to set up the server",
			`3. Run: npx husk server-setup`,
			"   → Creates admin account + API key",
			"   → Registers MCP clients locally",
		].join("\n"),
		"Next steps",
	);

	p.outro("Good luck with deployment!");
	process.exit(0);
}

function tryClipboard(text: string): boolean {
	const platform = process.platform;
	try {
		if (platform === "darwin") {
			execSync("pbcopy", { input: text, stdio: ["pipe", "ignore", "ignore"] });
			return true;
		}
		if (platform === "linux") {
			execSync("xclip -selection clipboard", { input: text, stdio: ["pipe", "ignore", "ignore"] });
			return true;
		}
		if (platform === "win32") {
			execSync("clip.exe", { input: text, stdio: ["pipe", "ignore", "ignore"] });
			return true;
		}
	} catch {
		// Clipboard not available
	}
	return false;
}

export interface DeployConfig {
	domain: string;
	provider: string;
	proxy: string;
	storage: string;
	embeddings: string;
}

export function generatePrompt(config: DeployConfig): string {
	const services = [];
	if (config.storage === "qdrant") services.push("Qdrant (vector database)");
	if (config.embeddings === "ollama") services.push("Ollama (embedding model)");

	const proxyNames: Record<string, string> = {
		caddy: "Caddy",
		nginx: "nginx",
		traefik: "Traefik",
		none: "no reverse proxy (I'll handle TLS)",
	};

	const providerNames: Record<string, string> = {
		vps: "a VPS / bare metal server",
		docker: "a server with Docker already installed",
		cloud: "a cloud platform (AWS/GCP/Azure)",
		other: "a server (details TBD)",
	};

	return `Help me deploy HUSK (a self-hosted memory server for AI coding assistants) on ${providerNames[config.provider] ?? config.provider}.

## My setup

- **Domain**: ${config.domain}
- **Reverse proxy**: ${proxyNames[config.proxy] ?? config.proxy}
- **Vector storage**: ${config.storage}
- **Embeddings**: ${config.embeddings}${services.length > 0 ? `\n- **Additional services**: ${services.join(", ")}` : ""}

## What I need you to help me with

Walk me through these steps, asking me questions as needed:

### Checklist

1. **Server preparation**
   - [ ] OS updates and basic security (firewall, SSH keys, fail2ban)
   - [ ] Install Docker and Docker Compose (if not already)
   - [ ] Create a dedicated user/directory for HUSK

2. **DNS setup**
   - [ ] Point \`${config.domain}\` to the server IP
   - [ ] Verify DNS propagation

3. **HUSK deployment**
   - [ ] Create \`docker-compose.yml\` with the HUSK server${services.length > 0 ? ` + ${services.join(" + ")}` : ""}
   - [ ] Configure environment variables (ports, database paths, JWT secret)
   - [ ] Set up persistent volumes for data
   - [ ] Start the stack and verify health: \`curl http://localhost:3000/health\`

4. **HTTPS / reverse proxy**${config.proxy !== "none" ? `
   - [ ] Install and configure ${proxyNames[config.proxy] ?? config.proxy}
   - [ ] Set up TLS for \`${config.domain}\` → \`localhost:3000\`
   - [ ] Verify HTTPS works: \`curl https://${config.domain}/health\`` : `
   - [ ] Set up TLS termination
   - [ ] Proxy traffic to \`localhost:3000\``}

5. **Security hardening**
   - [ ] Only expose ports 80/443 publicly (HUSK port 3000 stays internal)
   - [ ] Set a strong \`HUSK_JWT_SECRET\`
   - [ ] Consider rate limiting on the reverse proxy

6. **Backups**
   - [ ] Set up daily backup of the SQLite database
   - [ ] Test restore procedure

7. **Verification**
   - [ ] \`curl https://${config.domain}/health\` returns OK
   - [ ] Server is ready for admin setup (I'll run \`npx husk server-setup\` locally)

## Reference documentation

Read these docs for accurate configuration details:

- **Deployment guide**: ${DOCS.deployment}
- **Configuration reference**: ${DOCS.configuration}
- **Quick start (Docker Compose)**: ${DOCS.quickStart}
- **Connecting MCP clients**: ${DOCS.connecting}

## Important notes

- HUSK uses Bun as its runtime — the Docker image handles this, don't install Bun on the host
- The database is SQLite at \`HUSK_DB_PATH\` — this is the only file that needs backing up
- Vector data (${config.storage}) can be rebuilt from the SQLite database
- After the server is running, I will run \`npx husk server-setup\` from my local machine to create the admin account and API key
${config.proxy === "caddy" ? `
## Example Caddy config

\`\`\`
${config.domain} {
    reverse_proxy localhost:3000
}
\`\`\`

Caddy handles TLS automatically via Let's Encrypt.` : ""}
${config.proxy === "nginx" ? `
## Example nginx config

\`\`\`nginx
server {
    listen 443 ssl;
    server_name ${config.domain};

    ssl_certificate /etc/letsencrypt/live/${config.domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${config.domain}/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
\`\`\`

Use certbot for TLS: \`certbot --nginx -d ${config.domain}\`` : ""}

Please start by asking me about my server — what OS it's running, if Docker is installed, and any constraints I have.`;
}
