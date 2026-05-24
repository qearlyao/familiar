import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVICE_LABEL = "com.qearlyao.familiar";
const SYSTEMD_SERVICE = "familiar.service";

export type ServicePlatform = NodeJS.Platform;

export interface ServicePaths {
	servicePath: string;
	logDir: string;
	stdoutPath: string;
	stderrPath: string;
}

export interface ServiceSpec {
	platform: ServicePlatform;
	workspacePath: string;
	nodePath: string;
	cliPath: string;
	paths: ServicePaths;
}

export interface ServiceCommandResult {
	title: string;
	details: string[];
}

interface ServiceOptions {
	platform?: ServicePlatform;
	homeDir?: string;
	nodePath?: string;
	cliPath?: string;
	resolvePath?: (...paths: string[]) => string;
	userId?: number;
	commandExists?: (command: string) => Promise<boolean>;
	runCommand?: (command: string, args: string[]) => Promise<void>;
	captureCommand?: (command: string, args: string[]) => Promise<string>;
}

function resolveForOptions(options: ServiceOptions): (...paths: string[]) => string {
	return options.resolvePath ?? resolve;
}

function servicePaths(
	workspacePath: string,
	input: { platform: ServicePlatform; homeDir: string; resolvePath: (...paths: string[]) => string },
): ServicePaths {
	const logDir = input.resolvePath(workspacePath, "logs");
	return {
		servicePath:
			input.platform === "darwin"
				? input.resolvePath(input.homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`)
				: input.resolvePath(input.homeDir, ".config", "systemd", "user", SYSTEMD_SERVICE),
		logDir,
		stdoutPath: input.resolvePath(logDir, "familiar.out.log"),
		stderrPath: input.resolvePath(logDir, "familiar.err.log"),
	};
}

function buildSpec(workspacePath: string, options: ServiceOptions = {}): ServiceSpec {
	const currentPlatform = options.platform ?? platform();
	const cliPath = options.cliPath ?? currentCliPath();
	const resolvePath = resolveForOptions(options);
	const resolvedWorkspacePath = resolvePath(workspacePath);
	return {
		platform: currentPlatform,
		workspacePath: resolvedWorkspacePath,
		nodePath: options.nodePath ?? process.execPath,
		cliPath,
		paths: servicePaths(resolvedWorkspacePath, {
			platform: currentPlatform,
			homeDir: options.homeDir ?? homedir(),
			resolvePath,
		}),
	};
}

function currentCliPath(): string {
	if (!process.argv[1]) throw new Error("Cannot determine familiar CLI path for service installation.");
	return resolve(process.argv[1]);
}

function versionManagedPathWarning(spec: ServiceSpec): string | undefined {
	const joined = `${spec.nodePath}\n${spec.cliPath}`;
	const marker = ["/.nvm/", "/.asdf/", "/.fnm/", "/.volta/"].find((candidate) => joined.includes(candidate));
	if (!marker) return undefined;
	return `warning: service uses a version-manager path (${marker}); reinstall the service after changing Node versions.`;
}

function xmlEscape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function launchdPlist(spec: ServiceSpec): string {
	const args = [spec.nodePath, spec.cliPath, "run", spec.workspacePath]
		.map((value) => `\t\t<string>${xmlEscape(value)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${SERVICE_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xmlEscape(spec.workspacePath)}</string>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>30</integer>
\t<key>ExitTimeOut</key>
\t<integer>20</integer>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(spec.paths.stdoutPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(spec.paths.stderrPath)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>NODE_ENV</key>
\t\t<string>production</string>
\t</dict>
</dict>
</plist>
`;
}

function systemdUnit(spec: ServiceSpec): string {
	const execStart = [spec.nodePath, spec.cliPath, "run", spec.workspacePath].map(systemdQuote).join(" ");
	return `[Unit]
Description=Familiar companion agent
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${systemdQuote(spec.workspacePath)}
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
SuccessExitStatus=75
RestartForceExitStatus=75
Environment=NODE_ENV=production
StandardOutput=append:${spec.paths.stdoutPath}
StandardError=append:${spec.paths.stderrPath}

[Install]
WantedBy=default.target
`;
}

async function commandExists(command: string): Promise<boolean> {
	try {
		await execFileAsync(command, ["--version"]);
		return true;
	} catch {
		return false;
	}
}

async function hasCommand(command: string, options: ServiceOptions): Promise<boolean> {
	return options.commandExists ? options.commandExists(command) : commandExists(command);
}

async function run(command: string, args: string[], options: ServiceOptions): Promise<void> {
	if (options.runCommand) {
		await options.runCommand(command, args);
		return;
	}
	await execFileAsync(command, args);
}

async function capture(command: string, args: string[], options: ServiceOptions): Promise<string> {
	if (options.captureCommand) return options.captureCommand(command, args);
	const { stdout } = await execFileAsync(command, args);
	return stdout;
}

async function runOptional(command: string, args: string[], options: ServiceOptions): Promise<void> {
	try {
		await run(command, args, options);
	} catch {
		// Best-effort cleanup for stale service registrations.
	}
}

function guiDomain(options: ServiceOptions = {}): string {
	return `gui/${options.userId ?? userInfo().uid}`;
}

function unsupported(platformName: string): ServiceCommandResult {
	return {
		title: "Service management is not supported on this platform yet.",
		details: [
			`platform: ${platformName}`,
			"Windows users should keep Familiar running in a foreground terminal for now.",
		],
	};
}

export async function installService(
	workspacePath: string,
	options: ServiceOptions = {},
): Promise<ServiceCommandResult> {
	const spec = buildSpec(workspacePath, options);
	if (spec.platform !== "darwin" && spec.platform !== "linux") return unsupported(spec.platform);

	await mkdir(dirname(spec.paths.servicePath), { recursive: true });
	await mkdir(spec.paths.logDir, { recursive: true });
	const serviceText = spec.platform === "darwin" ? launchdPlist(spec) : systemdUnit(spec);
	await writeFile(spec.paths.servicePath, serviceText, "utf8");

	if (spec.platform === "darwin") {
		await runOptional("launchctl", ["bootout", guiDomain(options), spec.paths.servicePath], options);
		await run("launchctl", ["bootstrap", guiDomain(options), spec.paths.servicePath], options);
		await run("launchctl", ["kickstart", "-k", `${guiDomain(options)}/${SERVICE_LABEL}`], options);
	} else {
		if (!(await hasCommand("systemctl", options))) {
			throw new Error("systemctl is required to install the Linux user service.");
		}
		await run("systemctl", ["--user", "daemon-reload"], options);
		await run("systemctl", ["--user", "enable", "--now", SYSTEMD_SERVICE], options);
	}

	const details = [
		`workspace: ${spec.workspacePath}`,
		`service: ${spec.paths.servicePath}`,
		`stdout: ${spec.paths.stdoutPath}`,
		`stderr: ${spec.paths.stderrPath}`,
	];
	const pathWarning = versionManagedPathWarning(spec);
	if (pathWarning) details.push(pathWarning);

	return {
		title: "Familiar service installed.",
		details,
	};
}

export async function uninstallService(
	workspacePath: string,
	options: ServiceOptions = {},
): Promise<ServiceCommandResult> {
	const spec = buildSpec(workspacePath, options);
	if (spec.platform !== "darwin" && spec.platform !== "linux") return unsupported(spec.platform);

	if (spec.platform === "darwin") {
		await runOptional("launchctl", ["bootout", guiDomain(options), spec.paths.servicePath], options);
	} else {
		if (await hasCommand("systemctl", options)) {
			await runOptional("systemctl", ["--user", "disable", "--now", SYSTEMD_SERVICE], options);
		}
	}
	if (existsSync(spec.paths.servicePath)) await rm(spec.paths.servicePath);
	if (spec.platform === "linux" && (await hasCommand("systemctl", options))) {
		await runOptional("systemctl", ["--user", "daemon-reload"], options);
	}

	return {
		title: "Familiar service uninstalled.",
		details: [`service: ${spec.paths.servicePath}`],
	};
}

export async function serviceStatus(
	workspacePath: string,
	options: ServiceOptions = {},
): Promise<ServiceCommandResult> {
	const spec = buildSpec(workspacePath, options);
	if (spec.platform !== "darwin" && spec.platform !== "linux") return unsupported(spec.platform);

	const details = [
		`workspace: ${spec.workspacePath}`,
		`service: ${spec.paths.servicePath}`,
		`service_file: ${existsSync(spec.paths.servicePath) ? "present" : "missing"}`,
		`supervisor_state: ${await supervisorState(spec, options)}`,
		`stdout: ${spec.paths.stdoutPath}`,
		`stderr: ${spec.paths.stderrPath}`,
	];

	if (existsSync(spec.paths.servicePath)) {
		const serviceFile = await stat(spec.paths.servicePath);
		details.push(`service_file_mtime: ${serviceFile.mtime.toISOString()}`);
	}

	return { title: "Familiar service status.", details };
}

async function supervisorState(spec: ServiceSpec, options: ServiceOptions): Promise<string> {
	try {
		if (spec.platform === "darwin") {
			await capture("launchctl", ["print", `${guiDomain(options)}/${SERVICE_LABEL}`], options);
			return "loaded";
		}
		const state = (await capture("systemctl", ["--user", "is-active", SYSTEMD_SERVICE], options)).trim();
		return state || "unknown";
	} catch {
		return "not-loaded";
	}
}

export async function upgradeFamiliar(options: ServiceOptions = {}): Promise<void> {
	const currentPlatform = options.platform ?? platform();
	const npmCommand = currentPlatform === "win32" ? "npm.cmd" : "npm";
	await new Promise<void>((resolveUpgrade, rejectUpgrade) => {
		const child = spawn(npmCommand, ["install", "-g", "@qearlyao/familiar@latest"], {
			shell: currentPlatform === "win32",
			stdio: "inherit",
		});
		child.on("exit", (code) => {
			if (code === 0) resolveUpgrade();
			else rejectUpgrade(new Error(`npm upgrade failed with exit code ${code ?? "unknown"}`));
		});
		child.on("error", rejectUpgrade);
	});
}

export function formatServiceResult(result: ServiceCommandResult): string {
	return [result.title, ...result.details].join("\n");
}

export const __serviceTest = {
	SERVICE_LABEL,
	SYSTEMD_SERVICE,
	buildSpec,
	launchdPlist,
	systemdUnit,
	systemdQuote,
	xmlEscape,
	versionManagedPathWarning,
};
