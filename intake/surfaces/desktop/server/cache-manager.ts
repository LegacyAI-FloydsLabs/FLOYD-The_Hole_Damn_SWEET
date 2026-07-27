// SUPERCACHE - 3-Tier Caching System for FLOYD (Web Port)
// Tier 1: Reasoning - Current conversation (5 min TTL)
// Tier 2: Project - Project context (24 hours TTL)
// Tier 3: Vault - Reusable wisdom (7 days TTL)

import fs from 'fs/promises';
import path from 'path';

export type CacheTier = 'reasoning' | 'project' | 'vault';

export interface CacheEntry {
	key: string;
	value: string;
	timestamp: number;
	ttl: number; // milliseconds
	tier: CacheTier;
	metadata?: Record<string, unknown>;
	version?: number;
	lastAccess?: number;
}

const TTL_CONFIG: Record<CacheTier, number> = {
	reasoning: 5 * 60 * 1000, // 5 minutes
	project: 24 * 60 * 60 * 1000, // 24 hours
	vault: 7 * 24 * 60 * 60 * 1000, // 7 days
};

const SIZE_LIMITS: Record<CacheTier, number> = {
	reasoning: 100,
	project: 500,
	vault: 1000,
};

const CACHE_VERSION = 1;

export class CacheManager {
	private cacheRoot: string;
	private tiers: CacheTier[] = ['reasoning', 'project', 'vault'];

	constructor(dataDir: string) {
		this.cacheRoot = path.join(dataDir, '.cache');
	}

	private getTierPath(tier: CacheTier): string {
		return path.join(this.cacheRoot, tier);
	}

	private getEntryPath(tier: CacheTier, key: string): string {
		const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
		return path.join(this.getTierPath(tier), `${safeKey}.json`);
	}

	async store(
		tier: CacheTier,
		key: string,
		value: string,
		metadata?: Record<string, unknown>,
	): Promise<void> {
		const entry: CacheEntry = {
			key,
			value,
			timestamp: Date.now(),
			lastAccess: Date.now(),
			ttl: TTL_CONFIG[tier],
			tier,
			metadata,
			version: CACHE_VERSION,
		};

		const tierPath = this.getTierPath(tier);
		await fs.mkdir(tierPath, { recursive: true });
		
		await fs.writeFile(this.getEntryPath(tier, key), JSON.stringify(entry, null, 2));
		await this.enforceSizeLimit(tier);
	}

	async retrieve(tier: CacheTier, key: string): Promise<string | null> {
		const entryPath = this.getEntryPath(tier, key);

		try {
			const content = await fs.readFile(entryPath, 'utf-8');
			const entry: CacheEntry = JSON.parse(content);

			const now = Date.now();
			if (now - entry.timestamp > entry.ttl) {
				await this.delete(tier, key);
				return null;
			}

			entry.lastAccess = now;
			await fs.writeFile(entryPath, JSON.stringify(entry, null, 2));
			return entry.value;
		} catch {
			return null;
		}
	}

	async delete(tier: CacheTier, key: string): Promise<boolean> {
		try {
			await fs.unlink(this.getEntryPath(tier, key));
			return true;
		} catch {
			return false;
		}
	}

	async list(tier: CacheTier): Promise<CacheEntry[]> {
		const tierPath = this.getTierPath(tier);
		const entries: CacheEntry[] = [];
		try {
			const files = await fs.readdir(tierPath);
			for (const file of files) {
				if (file.endsWith('.json')) {
					const content = await fs.readFile(path.join(tierPath, file), 'utf-8');
					const entry: CacheEntry = JSON.parse(content);
					if (Date.now() - entry.timestamp <= entry.ttl) {
						entries.push(entry);
					}
				}
			}
		} catch {}
		return entries.sort((a, b) => b.timestamp - a.timestamp);
	}

	async search(tier: CacheTier, query: string): Promise<CacheEntry[]> {
		const all = await this.list(tier);
		const q = query.toLowerCase();
		return all.filter(e => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q));
	}

	private async enforceSizeLimit(tier: CacheTier): Promise<void> {
		const entries = await this.list(tier);
		const limit = SIZE_LIMITS[tier];
		if (entries.length <= limit) return;

		const toRemove = entries
			.sort((a, b) => (a.lastAccess || a.timestamp) - (b.lastAccess || b.timestamp))
			.slice(0, entries.length - limit);

		for (const entry of toRemove) {
			await this.delete(tier, entry.key);
		}
	}
}
