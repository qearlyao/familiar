import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVICE_LABEL = "com.qearlyao.familiar";
const LOG_ROTATION_LABEL = `${SERVICE_LABEL}.log-rotation`;
const SYSTEMD_SERVICE = "familiar.service";
const SYSTEMD_LOGROTATE_SERVICE = "familiar-logrotate.service";
const SYSTEMD_LOGROTATE_TIMER = "familiar-logrotate.timer";

export type ServicePlatform = NodeJS.Platform;

export interface ServicePaths {
	servicePath: string;
	logDir: string;
	stdoutPath: string;
	stderrPath: string;
	logrotateConfigPath: string;
	logrotateStatePath: string;
	logRotationScriptPath: string;
	logRotationLaunchdPath: string;
	logrotateServicePath: string;
	logrotateTimerPath: string;
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

type ServiceControlAction = "start" | "stop" | "restart";

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

function servicePaths(
	workspacePath: string,
	input: { platform: ServicePlatform; homeDir: string; resolvePath: (...paths: string[]) => string },
): ServicePaths {
	const logDir = input.resolvePath(workspacePath, "logs");
	const systemdUserDir = input.resolvePath(input.homeDir, ".config", "systemd", "user");
	return {
		servicePath:
			input.platform === "darwin"
				? input.resolvePath(input.homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`)
				: input.resolvePath(systemdUserDir, SYSTEMD_SERVICE),
		logDir,
		stdoutPath: input.resolvePath(logDir, "familiar.out.log"),
		stderrPath: input.resolvePath(logDir, "familiar.err.log"),
		logrotateConfigPath: input.resolvePath(logDir, "familiar.logrotate.conf"),
		logrotateStatePath: input.resolvePath(logDir, "familiar.logrotate.state"),
		logRotationScriptPath: input.resolvePath(logDir, "familiar-rotate-logs.sh"),
		logRotationLaunchdPath: input.resolvePath(
			input.homeDir,
			"Library",
			"LaunchAgents",
			`${LOG_ROTATION_LABEL}.plist`,
		),
		logrotateServicePath: input.resolvePath(systemdUserDir, SYSTEMD_LOGROTATE_SERVICE),
		logrotateTimerPath: input.resolvePath(systemdUserDir, SYSTEMD_LOGROTATE_TIMER),
	};
}

function buildSpec(workspacePath: string, options: ServiceOptions = {}): ServiceSpec {
	const currentPlatform = options.platform ?? platform();
	const cliPath = options.cliPath ?? currentCliPath();
	const resolvePath = options.resolvePath ?? resolve;
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

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function logrotateQuote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
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

function launchdLogRotationPlist(spec: ServiceSpec): string {
	const args = ["/bin/sh", spec.paths.logRotationScriptPath, spec.paths.stdoutPath, spec.paths.stderrPath]
		.map((value) => `\t\t<string>${xmlEscape(value)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LOG_ROTATION_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>StartInterval</key>
\t<integer>604800</integer>
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

function logRotationScript(): string {
	return `set -eu

for log_path in "$@"; do
\t[ -s "$log_path" ] || continue
\trm -f "$log_path.8.gz"
\tindex=7
\twhile [ "$index" -ge 1 ]; do
\t\tnext=$((index + 1))
\t\tif [ -f "$log_path.$index.gz" ]; then
\t\t\tmv "$log_path.$index.gz" "$log_path.$next.gz"
\t\tfi
\t\tindex=$((index - 1))
\tdone
\tcp "$log_path" "$log_path.1"
\t: > "$log_path"
\tgzip -f "$log_path.1"
done
`;
}

function logrotateConfig(spec: ServiceSpec): string {
	return `${[spec.paths.stdoutPath, spec.paths.stderrPath].map(logrotateQuote).join(" ")} {
	weekly
	rotate 8
	missingok
	notifempty
	copytruncate
	compress
	delaycompress
}
`;
}

function logrotateService(spec: ServiceSpec, logrotatePath: string): string {
	const execStart = [logrotatePath, "-s", spec.paths.logrotateStatePath, spec.paths.logrotateConfigPath]
		.map(systemdQuote)
		.join(" ");
	return `[Unit]
Description=Rotate Familiar service logs

[Service]
Type=oneshot
ExecStart=${execStart}
`;
}

function logrotateTimer(): string {
	return `[Unit]
Description=Rotate Familiar service logs weekly

[Timer]
OnCalendar=weekly
Persistent=true

[Install]
WantedBy=timers.target
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

async function commandPath(command: string, options: ServiceOptions): Promise<string | undefined> {
	if (!(await hasCommand(command, options))) return undefined;
	try {
		const output = await capture("sh", ["-c", `command -v ${shellQuote(command)}`], options);
		const [path] = output.trim().split(/\r?\n/);
		return path || undefined;
	} catch {
		return undefined;
	}
}

async function run(command: string, args: string[], options: ServiceOptions): Promise<void> {
	if (options.runCommand) {
		await options.runCommand(command, args);
		return;
	}
	await execFileAsync(command, args);
}

async function runInteractive(
	command: string,
	args: string[],
	options: ServiceOptions,
	errorPrefix: string,
): Promise<void> {
	const currentPlatform = options.platform ?? platform();
	if (options.runCommand) {
		await options.runCommand(command, args);
		return;
	}
	await new Promise<void>((resolveRun, rejectRun) => {
		const child = spawn(command, args, {
			shell: currentPlatform === "win32",
			stdio: "inherit",
		});
		child.on("exit", (code) => {
			if (code === 0) resolveRun();
			else rejectRun(new Error(`${errorPrefix} failed with exit code ${code ?? "unknown"}`));
		});
		child.on("error", rejectRun);
	});
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

interface LogRotationInstallResult {
	detail: string;
	installed: boolean;
}

function serviceDetails(spec: ServiceSpec): string[] {
	return [
		`workspace: ${spec.workspacePath}`,
		`service: ${spec.paths.servicePath}`,
		`stdout: ${spec.paths.stdoutPath}`,
		`stderr: ${spec.paths.stderrPath}`,
	];
}

async function prepareLogRotation(
	spec: ServiceSpec,
	options: ServiceOptions,
): Promise<LogRotationInstallResult | undefined> {
	if (spec.platform === "darwin") {
		await writeFile(spec.paths.logRotationScriptPath, logRotationScript(), "utf8");
		await writeFile(spec.paths.logRotationLaunchdPath, launchdLogRotationPlist(spec), "utf8");
		return { detail: `log_rotation: ${spec.paths.logRotationLaunchdPath}`, installed: true };
	}
	if (spec.platform !== "linux") return undefined;
	const logrotatePath = await commandPath("logrotate", options);
	if (!logrotatePath) {
		return {
			detail: "logrotate: unavailable; install logrotate and rerun familiar install-service",
			installed: false,
		};
	}
	await writeFile(spec.paths.logrotateConfigPath, logrotateConfig(spec), "utf8");
	await writeFile(spec.paths.logrotateServicePath, logrotateService(spec, logrotatePath), "utf8");
	await writeFile(spec.paths.logrotateTimerPath, logrotateTimer(), "utf8");
	return { detail: `logrotate: ${spec.paths.logrotateConfigPath}`, installed: true };
}

async function enableLogRotation(
	spec: ServiceSpec,
	result: LogRotationInstallResult | undefined,
	options: ServiceOptions,
): Promise<void> {
	if (!result?.installed) return;
	if (spec.platform === "darwin") {
		await runOptional("launchctl", ["bootout", guiDomain(options), spec.paths.logRotationLaunchdPath], options);
		await run("launchctl", ["bootstrap", guiDomain(options), spec.paths.logRotationLaunchdPath], options);
		return;
	}
	if (spec.platform === "linux") {
		await run("systemctl", ["--user", "enable", "--now", SYSTEMD_LOGROTATE_TIMER], options);
	}
}

async function removeLogRotation(spec: ServiceSpec, options: ServiceOptions): Promise<void> {
	if (spec.platform === "darwin") {
		await runOptional("launchctl", ["bootout", guiDomain(options), spec.paths.logRotationLaunchdPath], options);
	} else if (spec.platform === "linux" && (await hasCommand("systemctl", options))) {
		await runOptional("systemctl", ["--user", "disable", "--now", SYSTEMD_LOGROTATE_TIMER], options);
	}
	for (const path of [
		spec.paths.logRotationLaunchdPath,
		spec.paths.logRotationScriptPath,
		spec.paths.logrotateServicePath,
		spec.paths.logrotateTimerPath,
		spec.paths.logrotateConfigPath,
		spec.paths.logrotateStatePath,
	]) {
		if (existsSync(path)) await rm(path);
	}
}

function serviceControlTitle(action: ServiceControlAction): string {
	if (action === "start") return "Familiar service started.";
	if (action === "stop") return "Familiar service stopped.";
	return "Familiar service restarted.";
}

async function runLaunchdControl(
	action: ServiceControlAction,
	spec: ServiceSpec,
	options: ServiceOptions,
): Promise<void> {
	const domain = guiDomain(options);
	if (action === "stop") {
		await run("launchctl", ["bootout", domain, spec.paths.servicePath], options);
		return;
	}
	if (action === "restart") {
		await runOptional("launchctl", ["bootout", domain, spec.paths.servicePath], options);
		await run("launchctl", ["bootstrap", domain, spec.paths.servicePath], options);
		await run("launchctl", ["kickstart", "-k", `${domain}/${SERVICE_LABEL}`], options);
		return;
	}
	await runOptional("launchctl", ["bootstrap", domain, spec.paths.servicePath], options);
	await run("launchctl", ["kickstart", `${domain}/${SERVICE_LABEL}`], options);
}

async function runSystemdControl(action: ServiceControlAction, options: ServiceOptions): Promise<void> {
	if (!(await hasCommand("systemctl", options))) {
		throw new Error("systemctl is required to control the Linux user service.");
	}
	await run("systemctl", ["--user", action, SYSTEMD_SERVICE], options);
}

async function controlService(
	action: ServiceControlAction,
	workspacePath: string,
	options: ServiceOptions = {},
): Promise<ServiceCommandResult> {
	const spec = buildSpec(workspacePath, options);
	if (spec.platform !== "darwin" && spec.platform !== "linux") return unsupported(spec.platform);

	if (spec.platform === "darwin") {
		await runLaunchdControl(action, spec, options);
	} else {
		await runSystemdControl(action, options);
	}

	return {
		title: serviceControlTitle(action),
		details: serviceDetails(spec),
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
	const logRotation = await prepareLogRotation(spec, options);

	if (spec.platform === "darwin") {
		await runOptional("launchctl", ["bootout", guiDomain(options), spec.paths.servicePath], options);
		await run("launchctl", ["bootstrap", guiDomain(options), spec.paths.servicePath], options);
		await run("launchctl", ["kickstart", "-k", `${guiDomain(options)}/${SERVICE_LABEL}`], options);
		await enableLogRotation(spec, logRotation, options);
	} else {
		if (!(await hasCommand("systemctl", options))) {
			throw new Error("systemctl is required to install the Linux user service.");
		}
		await run("systemctl", ["--user", "daemon-reload"], options);
		await run("systemctl", ["--user", "enable", "--now", SYSTEMD_SERVICE], options);
		await enableLogRotation(spec, logRotation, options);
	}

	const details = serviceDetails(spec);
	if (logRotation) details.push(logRotation.detail);
	const pathWarning = versionManagedPathWarning(spec);
	if (pathWarning) details.push(pathWarning);

	return {
		title: "Familiar service installed.",
		details,
	};
}

export async function startService(workspacePath: string, options: ServiceOptions = {}): Promise<ServiceCommandResult> {
	return controlService("start", workspacePath, options);
}

export async function stopService(workspacePath: string, options: ServiceOptions = {}): Promise<ServiceCommandResult> {
	return controlService("stop", workspacePath, options);
}

export async function restartService(
	workspacePath: string,
	options: ServiceOptions = {},
): Promise<ServiceCommandResult> {
	return controlService("restart", workspacePath, options);
}

export async function uninstallService(
	workspacePath: string,
	options: ServiceOptions = {},
): Promise<ServiceCommandResult> {
	const spec = buildSpec(workspacePath, options);
	if (spec.platform !== "darwin" && spec.platform !== "linux") return unsupported(spec.platform);

	if (spec.platform === "darwin") {
		await runOptional("launchctl", ["bootout", guiDomain(options), spec.paths.servicePath], options);
		await removeLogRotation(spec, options);
	} else {
		if (await hasCommand("systemctl", options)) {
			await runOptional("systemctl", ["--user", "disable", "--now", SYSTEMD_SERVICE], options);
		}
		await removeLogRotation(spec, options);
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

export async function upgradeFamiliar(workspacePath: string, options: ServiceOptions = {}): Promise<void> {
	const currentPlatform = options.platform ?? platform();
	const npmCommand = currentPlatform === "win32" ? "npm.cmd" : "npm";
	const familiarCommand = currentPlatform === "win32" ? "familiar.cmd" : "familiar";
	await runInteractive(npmCommand, ["install", "-g", "@qearlyao/familiar@latest"], options, "npm upgrade");
	await runInteractive(npmCommand, ["install", "-g", "@jackwener/opencli"], options, "OpenCLI upgrade");
	await runInteractive(familiarCommand, ["init", workspacePath], options, "workspace default refresh");
}

export function formatServiceResult(result: ServiceCommandResult): string {
	return [result.title, ...result.details].join("\n");
}

export const __serviceTest = {
	SERVICE_LABEL,
	SYSTEMD_SERVICE,
	buildSpec,
	launchdPlist,
	launchdLogRotationPlist,
	systemdUnit,
	systemdQuote,
	logRotationScript,
	xmlEscape,
	versionManagedPathWarning,
};
