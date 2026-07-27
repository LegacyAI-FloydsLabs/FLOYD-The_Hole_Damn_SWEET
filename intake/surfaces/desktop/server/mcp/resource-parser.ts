/**
 * PHASE 5 ITEM 35: MCP Resource Mentions
 *
 * Parse and resolve MCP (Model Context Protocol) resource mentions in prompts.
 * Enables @resource:// syntax for referencing MCP server resources.
 */

import { EventEmitter } from 'events';

/**
 * Parsed resource mention
 */
export interface ResourceMention {
	protocol: 'resource' | 'res';
	server: string;
	path: string;
	query?: Record<string, string>;
	fragment?: string;
	raw: string;
	start: number;
	end: number;
}

/**
 * Resolved resource value
 */
export interface ResourceValue {
	content: string;
	mimeType?: string;
	uri: string;
	metadata?: Record<string, unknown>;
}

/**
 * Resource resolver function
 */
export type ResourceResolver = (
	server: string,
	path: string,
	query?: Record<string, string>
) => Promise<ResourceValue | null>;

/**
 * Parse options
 */
export interface ParseOptions {
	allowBrackets?: boolean; // Allow @resource://server/path[@query]
	allowRelative?: boolean; // Allow @resource://path (relative to default server)
	defaultServer?: string;
}

/**
 * Parse result
 */
export interface ParseResult {
	mentions: ResourceMention[];
	text: string;
}

/**
 * MCP resource mention patterns
 */
const RESOURCE_PATTERNS = {
	// Standard: @resource://server/path
	standard: /@resource:\/\/([a-zA-Z0-9_-]+)(\/[^\s]*)?/g,

	// Short: @res://server/path
	short: /@res:\/\/([a-zA-Z0-9_-]+)(\/[^\s]*)?/g,

	// With query: @resource://server/path?param=value
	withQuery: /@resource:\/\/([a-zA-Z0-9_-]+)(\/[^\s?]*)?(\?[^\s#]*)?/g,

	// With fragment: @resource://server/path#fragment
	withFragment: /@resource:\/\/([a-zA-Z0-9_-]+)(\/[^\s#]*)?(#[^\s]*)?/g,
};

/**
 * MCP Resource Mention Parser
 */
export class MCPResourceParser extends EventEmitter {
	private resolvers: Map<string, ResourceResolver> = new Map();
	private defaultServer?: string;
	private cache: Map<string, ResourceValue> = new Map();
	private cacheEnabled: boolean = true;
	private cacheTTL: number = 5 * 60 * 1000; // 5 minutes
	private cacheTimestamps: Map<string, number> = new Map();

	constructor(options?: { defaultServer?: string; enableCache?: boolean; cacheTTL?: number }) {
		super();
		this.defaultServer = options?.defaultServer;
		this.cacheEnabled = options?.enableCache ?? true;
		if (options?.cacheTTL) {
			this.cacheTTL = options.cacheTTL;
		}
	}

	/**
	 * Register a resource resolver for a server
	 */
	registerResolver(server: string, resolver: ResourceResolver): void {
		this.resolvers.set(server, resolver);
		this.emit('resolver-registered', { server });
	}

	/**
	 * Unregister a resolver
	 */
	unregisterResolver(server: string): void {
		this.resolvers.delete(server);
		this.emit('resolver-unregistered', { server });
	}

	/**
	 * Parse text for resource mentions
	 */
	parse(text: string, options?: ParseOptions): ParseResult {
		const mentions: ResourceMention[] = [];
		const defaultServer = options?.defaultServer || this.defaultServer;

		// Try all patterns
		const patterns = [
			RESOURCE_PATTERNS.withQuery,
			RESOURCE_PATTERNS.withFragment,
			RESOURCE_PATTERNS.standard,
			RESOURCE_PATTERNS.short,
		];

		for (const pattern of patterns) {
			pattern.lastIndex = 0; // Reset regex state
			let match;
			while ((match = pattern.exec(text)) !== null) {
				const raw = match[0];
				const start = match.index;
				const end = start + raw.length;

				// Extract components
				const protocol = raw.startsWith('@res://') ? 'res' : 'resource';
				const server = match[1] || defaultServer || 'default';
				const fullPath = match[2] || '/';
				const queryString = match[3];
				const fragment = match[4]?.replace('#', '') || '';

				// Parse path and query
				const [path, ...queryParts] = fullPath.split('?');
				const basePath = path || '/';

				// Parse query string
				const query: Record<string, string> = {};
				if (queryString || queryParts.length > 0) {
					const qs = queryString || queryParts.join('?');
					const params = new URLSearchParams(qs.replace('?', ''));
					for (const [key, value] of params.entries()) {
						query[key] = value;
					}
				}

				mentions.push({
					protocol,
					server,
					path: basePath,
					query: Object.keys(query).length > 0 ? query : undefined,
					fragment: fragment || undefined,
					raw,
					start,
					end,
				});
			}
		}

		// Sort by position and deduplicate
		const sorted = mentions
			.sort((a, b) => a.start - b.start)
			.filter((mention, index, arr) => {
				// Remove overlapping mentions
				const prev = arr[index - 1];
				return !prev || mention.start >= prev.end;
			});

		return { mentions: sorted, text };
	}

	/**
	 * Resolve a single resource mention
	 */
	async resolve(mention: ResourceMention): Promise<ResourceValue | null> {
		const cacheKey = `${mention.server}:${mention.path}:${JSON.stringify(mention.query)}`;

		// Check cache
		if (this.cacheEnabled && this.cache.has(cacheKey)) {
			const timestamp = this.cacheTimestamps.get(cacheKey) || 0;
			if (Date.now() - timestamp < this.cacheTTL) {
				this.emit('cache-hit', { key: cacheKey });
				return this.cache.get(cacheKey)!;
			} else {
				// Expired
				this.cache.delete(cacheKey);
				this.cacheTimestamps.delete(cacheKey);
			}
		}

		// Get resolver
		const resolver = this.resolvers.get(mention.server);
		if (!resolver) {
			this.emit('resolver-not-found', { server: mention.server });
			return null;
		}

		// Resolve
		this.emit('resolving', { mention });
		try {
			const value = await resolver(mention.server, mention.path, mention.query);

			if (value && this.cacheEnabled) {
				this.cache.set(cacheKey, value);
				this.cacheTimestamps.set(cacheKey, Date.now());
			}

			this.emit('resolved', { mention, value });
			return value;
		} catch (error) {
			this.emit('resolve-error', { mention, error });
			return null;
		}
	}

	/**
	 * Resolve all mentions in text
	 */
	async resolveAll(text: string, options?: ParseOptions): Promise<{
		resolved: string;
		values: Map<string, ResourceValue>;
		errors: Array<{ mention: ResourceMention; error: unknown }>;
	}> {
		const { mentions } = this.parse(text, options);
		const values = new Map<string, ResourceValue>();
		const errors: Array<{ mention: ResourceMention; error: unknown }> = [];

		// Sort mentions in reverse order (to replace from end to start)
		const sorted = [...mentions].sort((a, b) => b.start - a.start);

		let resolved = text;

		for (const mention of sorted) {
			const value = await this.resolve(mention);
			const key = `${mention.server}:${mention.path}`;

			if (value) {
				values.set(key, value);
				// Replace mention with content
				resolved =
					resolved.slice(0, mention.start) +
					value.content +
					resolved.slice(mention.end);
			} else {
				errors.push({ mention, error: 'Resolver returned null' });
			}
		}

		return { resolved, values, errors };
	}

	/**
	 * Get resource info without resolving
	 */
	getResourceInfo(mention: ResourceMention): {
		server: string;
		path: string;
		fullPath: string;
		hasResolver: boolean;
	} {
		const resolver = this.resolvers.has(mention.server);
		return {
			server: mention.server,
			path: mention.path,
			fullPath: `${mention.server}${mention.path}`,
			hasResolver: resolver,
		};
	}

	/**
	 * Clear cache
	 */
	clearCache(): void {
		this.cache.clear();
		this.cacheTimestamps.clear();
		this.emit('cache-cleared');
	}

	/**
	 * Get cache stats
	 */
	getCacheStats(): {
		size: number;
		keys: string[];
		ttl: number;
	} {
		return {
			size: this.cache.size,
			keys: Array.from(this.cache.keys()),
			ttl: this.cacheTTL,
		};
	}

	/**
	 * Enable/disable cache
	 */
	setCacheEnabled(enabled: boolean): void {
		this.cacheEnabled = enabled;
		if (!enabled) {
			this.clearCache();
		}
	}

	/**
	 * Set cache TTL
	 */
	setCacheTTL(ttl: number): void {
		this.cacheTTL = ttl;
	}
}

/**
 * Built-in resolvers
 */

/**
 * File system resolver (for local files)
 */
export function createFileResolver(basePath: string): ResourceResolver {
	return async (server: string, path: string) => {
		const { promises: fs } = await import('fs');
		const pathModule = await import('path');

		const fullPath = pathModule.join(basePath, path);

		try {
			const content = await fs.readFile(fullPath, 'utf-8');
			return {
				content,
				mimeType: getMimeType(fullPath),
				uri: `file://${fullPath}`,
			};
		} catch {
			return null;
		}
	};
}

/**
 * Memory resolver (for in-memory resources)
 */
export function createMemoryResolver(): ResourceResolver {
	const store = new Map<string, { content: string; mimeType?: string }>();

	return async (server: string, path: string) => {
		const key = `${server}:${path}`;
		const value = store.get(key);
		if (value) {
			return {
				content: value.content,
				mimeType: value.mimeType,
				uri: `memory://${key}`,
			};
		}
		return null;
	};
}

/**
 * HTTP resolver (for remote resources)
 */
export function createHTTPResolver(fetchFn: typeof fetch): ResourceResolver {
	return async (server: string, path: string) => {
		try {
			const url = `https://${server}${path}`;
			const response = await fetchFn(url);

			if (!response.ok) {
				return null;
			}

			const content = await response.text();
			const contentType = response.headers.get('content-type') || undefined;

			return {
				content,
				mimeType: contentType,
				uri: url,
			};
		} catch {
			return null;
		}
	};
}

/**
 * Get MIME type based on file extension
 */
function getMimeType(filePath: string): string {
	const ext = filePath.split('.').pop()?.toLowerCase();
	const mimeTypes: Record<string, string> = {
		txt: 'text/plain',
		md: 'text/markdown',
		json: 'application/json',
		html: 'text/html',
		css: 'text/css',
		js: 'text/javascript',
		ts: 'text/typescript',
		xml: 'application/xml',
		pdf: 'application/pdf',
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		gif: 'image/gif',
		svg: 'image/svg+xml',
	};
	return mimeTypes[ext || ''] || 'text/plain';
}

/**
 * Format resource mention as string
 */
export function formatMention(mention: Omit<ResourceMention, 'raw' | 'start' | 'end'>): string {
	let uri = `@${mention.protocol}://${mention.server}${mention.path}`;

	if (mention.query && Object.keys(mention.query).length > 0) {
		const params = new URLSearchParams(mention.query);
		uri += `?${params.toString()}`;
	}

	if (mention.fragment) {
		uri += `#${mention.fragment}`;
	}

	return uri;
}

/**
 * Create a resource mention from components
 */
export function createMention(
	server: string,
	path: string,
	options?: {
		protocol?: 'resource' | 'res';
		query?: Record<string, string>;
		fragment?: string;
	}
): string {
	return formatMention({
		protocol: options?.protocol || 'resource',
		server,
		path,
		query: options?.query,
		fragment: options?.fragment,
	});
}

/**
 * Global parser instance
 */
let globalParser: MCPResourceParser | null = null;

export function getMCPResourceParser(options?: {
	defaultServer?: string;
	enableCache?: boolean;
	cacheTTL?: number;
}): MCPResourceParser {
	if (!globalParser) {
		globalParser = new MCPResourceParser(options);
	}
	return globalParser;
}
