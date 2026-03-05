import * as vscode from 'vscode';
import * as path from 'path';
import { exec, ChildProcess } from 'child_process';
import * as fs from 'fs';

let lastErrorCount = 0;
let lastPlayTime = 0;
/** Current playback process so we can stop it when a new error triggers (one sound at a time) */
let currentPlaybackProcess: ChildProcess | null = null;

function stopCurrentSound() {
	if (currentPlaybackProcess) {
		try {
			currentPlaybackProcess.kill('SIGKILL');
		} catch {
			// ignore
		}
		currentPlaybackProcess = null;
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
			if (now - lastPlayTime >= debounceMs) {
				playSound(context);
				lastPlayTime = now;
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
	stopCurrentSound();

	const config = vscode.workspace.getConfiguration('errorSound');
	const debug = config.get<boolean>('debug', false);
	const soundPath = getSoundPath(context);

	if (soundPath) {
		if (debug) console.log('[Error Sound] Playing:', soundPath);
		playSoundFile(soundPath);
		return;
	}

	// No custom file: use system sound on macOS so user always hears something
	if (process.platform === 'darwin') {
		const systemSound = '/System/Library/Sounds/Ping.aiff';
		if (fs.existsSync(systemSound)) {
			if (debug) console.log('[Error Sound] Playing system sound (no custom file in media/)');
			currentPlaybackProcess = exec(`afplay "${systemSound}"`, (err) => {
				currentPlaybackProcess = null;
				if (err) console.warn('[Error Sound] afplay failed:', err.message);
			});
			return;
		}
	}
	if (debug) console.warn('[Error Sound] No media file (kattakada.mp3 / ffaa.mp3) in media/. Add one or use system sound.');
	fallbackBeep();
}

function playSoundFile(soundPath: string) {
	// Always use system player so we can stop it when a new error triggers (single sound at a time)
	playViaSystemPlayer(soundPath);
}

function playViaSystemPlayer(soundPath: string) {
	const platform = process.platform;
	if (platform === 'darwin') {
		currentPlaybackProcess = exec(`afplay "${soundPath}"`, (err) => {
			currentPlaybackProcess = null;
			if (err) console.warn('[Error Sound] afplay failed:', err.message);
		});
	} else if (platform === 'linux') {
		currentPlaybackProcess = exec(`paplay "${soundPath}" || aplay "${soundPath}"`, (err) => {
			currentPlaybackProcess = null;
			if (err) console.warn('[Error Sound] Linux player failed:', err.message);
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
	stopCurrentSound();
}
