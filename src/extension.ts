import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, exec, ChildProcess } from 'child_process';
import * as fs from 'fs';

let lastErrorCount = 0;
let lastPlayTime = 0;
/** The actual afplay/paplay process (spawn, not exec) so killing it stops sound immediately */
let currentPlaybackProcess: ChildProcess | null = null;
/** Coalesce rapid diagnostic events into a single play */
let playScheduled: ReturnType<typeof setTimeout> | null = null;
/** Incremented each time we schedule a play; only the latest actually starts (no overlap) */
let playGeneration = 0;
/** True while we're waiting for stopCurrentSound callback (so we allow replace without debounce) */
let playPending = false;
/** Gap after killall before starting new sound (ms) */
const GAP_AFTER_STOP_MS = 200;

/** Stop our process and all afplay/paplay; if done provided, call it after killall + gap (safe to start new sound) */
function stopCurrentSound(done?: () => void) {
	if (currentPlaybackProcess) {
		try {
			currentPlaybackProcess.kill('SIGKILL');
		} catch {
			// ignore
		}
		currentPlaybackProcess = null;
	}
	const platform = process.platform;
	const onDone = done ? () => setTimeout(done, GAP_AFTER_STOP_MS) : () => {};
	if (platform === 'darwin') {
		exec('killall afplay 2>/dev/null || true', onDone);
	} else if (platform === 'linux') {
		exec('killall paplay 2>/dev/null; killall aplay 2>/dev/null; true', onDone);
	} else {
		onDone();
	}
}

export function activate(context: vscode.ExtensionContext) {
	const config = vscode.workspace.getConfiguration('errorSound');
	const debounceMs = config.get<number>('debounceMs', 500);

	const disposable = vscode.languages.onDidChangeDiagnostics(() => {
		if (!config.get<boolean>('enabled', true)) {
			return;
		}

		const playOnWarning = config.get<boolean>('playOnWarning', false);
		const diagnostics = vscode.languages.getDiagnostics();

		let errorCount = 0;
		let warningCount = 0;

		for (const [, diagnosticList] of diagnostics) {
			for (const diag of diagnosticList) {
				if (diag.severity === vscode.DiagnosticSeverity.Error) {
					errorCount++;
				} else if (playOnWarning && diag.severity === vscode.DiagnosticSeverity.Warning) {
					warningCount++;
				}
			}
		}

		const totalCount = errorCount + (playOnWarning ? warningCount : 0);

		// Play only when count INCREASED (new error appeared)
		if (totalCount > lastErrorCount) {
			const now = Date.now();
			const debouncePassed = now - lastPlayTime >= debounceMs;
			// If we're already playing or waiting for stop callback, allow "replace" (new error = stop old, play for latest)
			const replacing = currentPlaybackProcess !== null || playPending;
			if (debouncePassed || replacing) {
				lastPlayTime = now;
				// Coalesce: multiple events in 120ms → only one playSound() for the latest
				if (playScheduled) clearTimeout(playScheduled);
				const ctx = context;
				playScheduled = setTimeout(() => {
					playScheduled = null;
					playSound(ctx);
				}, 120);
			}
		}

		lastErrorCount = totalCount;
	});

	context.subscriptions.push(disposable);
}

function getSoundPath(context: vscode.ExtensionContext): string | null {
	const config = vscode.workspace.getConfiguration('errorSound');
	const customName = config.get<string>('soundFile', '');
	const mediaDir = path.join(context.extensionPath, 'media');

	const toTry = customName ? [customName] : ['kattakada.mp3', 'ffaa.mp3'];
	for (const name of toTry) {
		const p = path.join(mediaDir, name);
		if (fs.existsSync(p)) return p;
	}
	// Any .mp3 or .wav in media/
	try {
		const names = fs.readdirSync(mediaDir);
		const first = names.find((n) => n.endsWith('.mp3') || n.endsWith('.wav'));
		if (first) return path.join(mediaDir, first);
	} catch {
		// no media dir or not readable
	}
	return null;
}

function playSound(context: vscode.ExtensionContext) {
	playGeneration++;
	const myGen = playGeneration;
	playPending = true;
	// Stop current playback; when killall + gap are done, start new sound only if this is still the latest
	stopCurrentSound(() => {
		playPending = false;
		if (myGen !== playGeneration) return;

		const config = vscode.workspace.getConfiguration('errorSound');
		const debug = config.get<boolean>('debug', false);
		const soundPath = getSoundPath(context);

		if (soundPath) {
			if (debug) console.log('[Error Sound] Playing:', soundPath);
			playSoundFile(soundPath);
			return;
		}

		if (process.platform === 'darwin') {
			const systemSound = '/System/Library/Sounds/Ping.aiff';
			if (fs.existsSync(systemSound)) {
				if (debug) console.log('[Error Sound] Playing system sound (no custom file in media/)');
				startAfplay(systemSound);
				return;
			}
		}
		if (debug) console.warn('[Error Sound] No media file (kattakada.mp3 / ffaa.mp3) in media/. Add one or use system sound.');
		fallbackBeep();
	});
}

function playSoundFile(soundPath: string) {
	playViaSystemPlayer(soundPath);
}

/** Spawn afplay directly (no shell) so we get the real process and killing it stops sound immediately */
function startAfplay(soundPath: string) {
	const p = spawn('afplay', [soundPath], { stdio: 'ignore' });
	currentPlaybackProcess = p;
	p.on('error', (err) => {
		currentPlaybackProcess = null;
		console.warn('[Error Sound] afplay failed:', err.message);
	});
	p.on('exit', () => {
		currentPlaybackProcess = null;
	});
}

function playViaSystemPlayer(soundPath: string) {
	const platform = process.platform;
	if (platform === 'darwin') {
		startAfplay(soundPath);
	} else if (platform === 'linux') {
		const p = spawn('paplay', [soundPath], { stdio: 'ignore' });
		currentPlaybackProcess = p;
		p.on('error', (err) => {
			currentPlaybackProcess = null;
			console.warn('[Error Sound] paplay failed:', err.message);
		});
		p.on('exit', () => {
			currentPlaybackProcess = null;
		});
	} else {
		fallbackBeep();
	}
}

function fallbackBeep() {
	// Simple terminal beep as last resort
	process.stdout.write('\x07');
}

export function deactivate() {
	if (playScheduled) clearTimeout(playScheduled);
	playScheduled = null;
	playGeneration++; // so any in-flight stopCurrentSound callback will no-op
	stopCurrentSound();
}
